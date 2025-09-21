import React, { useState, useEffect, useRef } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { processAudio, createChat, blobToBase64, continueAudioDictation, base64ToBlob, modifyFindingWithAudio } from '../services/geminiService';
import Spinner from './ui/Spinner';
import MicIcon from './icons/MicIcon';
import StopIcon from './icons/StopIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import UploadIcon from './icons/UploadIcon';
import ChevronDownIcon from './icons/ChevronDownIcon';
import { Chat } from '@google/genai';
import ChatInterface from './ChatInterface';
import PencilIcon from './icons/PencilIcon';
import MicPlusIcon from './icons/MicPlusIcon';
import TrashIcon from './icons/TrashIcon';
import { generateBatchDictationHTML } from '../services/htmlGenerator';
import SelectionCopier from './ui/SelectionCopier';
import MicPencilIcon from './icons/MicPencilIcon';


type BatchStatus = 'idle' | 'recording' | 'paused' | 'complete' | 'processing' | 'error';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

interface Batch {
    id: string;
    name: string;
    audioBlobs: Blob[];
    findings: string[] | null;
    status: BatchStatus;
    selectedModel: string;
    error?: string;
    chat?: Chat | null;
    chatHistory?: ChatMessage[];
    isChatting?: boolean;
}

interface BatchProcessorProps {
    onBack: () => void;
    selectedModel: string;
}

const BATCH_MODE_STORAGE_KEY = 'radiologyDictationBatchMode';

// Define serializable types for localStorage
interface SerializableAudioBlob {
    data: string;
    type: string;
}
// Omit non-serializable 'chat' property
interface SerializableBatch extends Omit<Batch, 'audioBlobs' | 'chat'> {
    audioBlobs: SerializableAudioBlob[];
}

const parseStructuredFinding = (finding: string) => {
  const parts = finding.split('###');
  if (parts.length > 1 && parts[0].trim() !== '') {
    return {
      isStructured: true,
      title: parts[0],
      points: parts.slice(1).filter(p => p.trim() !== ''),
    };
  }
  return {
    isStructured: false,
    title: finding,
    points: [],
  };
};


declare const ClipboardItem: any;

const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if (!mimeType) {
        return 'audio/ogg';
    }
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    return mimeType.split(';')[0];
};

const BatchProcessor: React.FC<BatchProcessorProps> = ({ onBack, selectedModel }) => {
    const [batches, setBatches] = useState<Batch[]>([]);
    const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
    const { isRecording: isMainRecording, stopRecording: stopMainRecording, startRecording: startMainRecording, error: mainRecorderError } = useAudioRecorder();
    const { isRecording: isContinuationRecording, startRecording: startContinuationRecording, stopRecording: stopContinuationRecording, error: continuationRecorderError } = useAudioRecorder();
    const { startRecording: startBatchContinuation, stopRecording: stopBatchContinuation, error: batchContinuationError } = useAudioRecorder();
    const [continuationState, setContinuationState] = useState<{ batchId: string | null; status: 'idle' | 'recording' | 'processing'; error: string | null }>({ batchId: null, status: 'idle', error: null });
    const [isBusy, setIsBusy] = useState(false);
    const [openAccordion, setOpenAccordion] = useState<string | null>(null);
    
    const [selections, setSelections] = useState<Record<string, Set<number>>>({});
    const [allCopiedId, setAllCopiedId] = useState<string | null>(null);
    const [isAllBatchesCopied, setIsAllBatchesCopied] = useState(false);
    const [copyNotification, setCopyNotification] = useState<{ text: string; visible: boolean }>({ text: '', visible: false });
    const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadTargetBatchId, setUploadTargetBatchId] = useState<string | null>(null);

    // State for Edit Mode
    const [editingState, setEditingState] = useState<{ batchId: string; index: number } | null>(null);
    const [editingText, setEditingText] = useState<string>('');
    const [dictatingState, setDictatingState] = useState<{ batchId: string; index: number } | null>(null);
    const [dictateEditingState, setDictateEditingState] = useState<{ batchId: string; index: number } | null>(null);
    const [processingState, setProcessingState] = useState<{ batchId: string; index: number } | null>(null);
    const [continuationError, setContinuationError] = useState<{ batchId: string; index: number; message: string } | null>(null);
    const modifyRecorder = useAudioRecorder();
    
    // State for selection copier
    const [selectionSnippets, setSelectionSnippets] = useState<Record<string, Record<number, string>>>({});
    const [copier, setCopier] = useState<{ visible: boolean; x: number; y: number; text: string } | null>(null);
    const findingsContainerRef = useRef<HTMLDivElement>(null);
    
     // Load state from localStorage on initial render
    useEffect(() => {
        const loadState = async () => {
        try {
            const savedStateJSON = localStorage.getItem(BATCH_MODE_STORAGE_KEY);
            if (savedStateJSON) {
            const savedBatches: SerializableBatch[] = JSON.parse(savedStateJSON);
            
            const restoredBatches: Batch[] = await Promise.all(savedBatches.map(async (savedBatch) => {
                const audioBlobs = savedBatch.audioBlobs.map(sa => base64ToBlob(sa.data, sa.type));
                
                let chat: Chat | null = null;
                // Recreate chat session for batches that have been processed
                if (savedBatch.status === 'complete' && savedBatch.findings && audioBlobs.length > 0) {
                try {
                    const mergedBlob = new Blob(audioBlobs, { type: audioBlobs[0]?.type || 'audio/webm' });
                    chat = await createChat(mergedBlob, savedBatch.findings, savedBatch.selectedModel);
                } catch (e) {
                    console.error(`Failed to recreate chat for batch ${savedBatch.name}:`, e);
                }
                }

                return {
                ...savedBatch,
                audioBlobs,
                chat,
                };
            }));
            
            if (restoredBatches.length > 0) {
                setBatches(restoredBatches);
                // Open the first processed batch accordion for better UX
                const firstProcessed = restoredBatches.find(b => b.findings);
                if (firstProcessed) {
                setOpenAccordion(firstProcessed.id);
                }
            }
            }
        } catch (error) {
            console.error("Failed to load batch state from localStorage:", error);
            localStorage.removeItem(BATCH_MODE_STORAGE_KEY);
        }
        };
        loadState();
    }, []);

    // Save state to localStorage whenever batches change
    useEffect(() => {
        const saveState = async () => {
            if (batches.length === 0) {
                // If user removes all batches, clear storage
                if (localStorage.getItem(BATCH_MODE_STORAGE_KEY)) {
                    localStorage.removeItem(BATCH_MODE_STORAGE_KEY);
                }
                return;
            }
            
            try {
                const serializableBatches: SerializableBatch[] = await Promise.all(
                    batches.map(async (batch) => {
                        const serializableAudioBlobs = await Promise.all(
                        batch.audioBlobs.map(async (blob) => ({
                            data: await blobToBase64(blob),
                            type: getCleanMimeType(blob),
                        }))
                        );

                        const { chat, ...rest } = batch;

                        return {
                        ...rest,
                        audioBlobs: serializableAudioBlobs,
                        };
                    })
                );

                localStorage.setItem(BATCH_MODE_STORAGE_KEY, JSON.stringify(serializableBatches));
            } catch (error) {
                console.error("Failed to save batch state to localStorage:", error);
            }
        };
        
        saveState();
    }, [batches]);

    // Add mouse up handler for text selection
    useEffect(() => {
        const handleMouseUp = (event: MouseEvent) => {
        setTimeout(() => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            if (!multiSelectMode) setCopier(null);
            return;
            }

            const selectedText = selection.toString().trim();
            if (selectedText.length === 0) {
            if (!multiSelectMode) setCopier(null);
            return;
            }

            const range = selection.getRangeAt(0);
            let parentElement = range.commonAncestorContainer;
            if (parentElement.nodeType === Node.TEXT_NODE) {
            parentElement = parentElement.parentElement!;
            }
            
            const findingItem = (parentElement as HTMLElement).closest('.finding-item');

            if (findingItem && findingItem.contains(parentElement)) {
            const batchId = findingItem.getAttribute('data-batch-id');
            const indexStr = findingItem.getAttribute('data-finding-index');

            if (batchId && indexStr) {
                const index = parseInt(indexStr, 10);
                
                if (multiSelectMode) {
                setSelectionSnippets(prev => ({
                    ...prev,
                    [batchId]: {
                    ...(prev[batchId] || {}),
                    [index]: selectedText,
                    },
                }));
                } else {
                setCopier({
                    visible: true,
                    x: event.clientX,
                    y: event.clientY,
                    text: selectedText,
                });
                }
            }
            } else {
            if (!multiSelectMode) setCopier(null);
            }
        }, 10);
        };

        const container = findingsContainerRef.current;
        container?.addEventListener('mouseup', handleMouseUp as EventListener);

        return () => {
        container?.removeEventListener('mouseup', handleMouseUp as EventListener);
        };
    }, [multiSelectMode]);
    
    useEffect(() => {
        if (mainRecorderError && activeBatchId) {
             setBatches(prevBatches =>
                prevBatches.map(b =>
                    b.id === activeBatchId ? { ...b, status: 'error', error: mainRecorderError } : b
                )
            );
            setActiveBatchId(null);
            setIsBusy(false);
        }
    }, [mainRecorderError, activeBatchId]);

    useEffect(() => {
        if (continuationRecorderError && dictatingState) {
            setContinuationError({ ...dictatingState, message: continuationRecorderError });
            setDictatingState(null);
        }
    }, [continuationRecorderError, dictatingState]);

    useEffect(() => {
        if (modifyRecorder.error && dictateEditingState) {
            setContinuationError({ ...dictateEditingState, message: modifyRecorder.error });
            setDictateEditingState(null);
        }
    }, [modifyRecorder.error, dictateEditingState]);

    useEffect(() => {
        if (batchContinuationError && continuationState.batchId) {
            setContinuationState({ batchId: continuationState.batchId, status: 'idle', error: batchContinuationError });
        }
    }, [batchContinuationError, continuationState.batchId]);


    const addBatch = () => {
        const newBatch: Batch = {
            id: crypto.randomUUID(),
            name: `Dictation #${batches.length + 1}`,
            audioBlobs: [],
            findings: null,
            status: 'idle',
            isChatting: false,
            selectedModel: selectedModel,
        };
        setBatches(prev => [...prev, newBatch]);
    };
    
    const removeBatch = (id: string) => {
        if (isMainRecording) {
            alert("Please stop recording before removing a dictation batch.");
            return;
        }
        if (window.confirm('Are you sure you want to remove this dictation batch? This action cannot be undone.')) {
            setBatches(prev => prev.filter(b => b.id !== id));
        }
    };

    const clearAllBatches = () => {
        if (isMainRecording) {
            alert("Please stop recording before clearing all batches.");
            return;
        }
        if (batches.length > 0 && window.confirm('Are you sure you want to remove ALL dictation batches? This action cannot be undone.')) {
            setBatches([]);
        }
    };


    const updateBatchName = (id: string, name: string) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, name } : b));
    };

    const updateBatchModel = (id: string, model: string) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, selectedModel: model } : b));
    };

    const handleRecordOrResume = async (batch: Batch) => {
        if (isBusy) return;
        setIsBusy(true);
    
        let capturedBlob: Blob | null = null;
        const previouslyActiveBatchId = activeBatchId;
    
        // If we are currently recording another batch, stop it first.
        if (isMainRecording && previouslyActiveBatchId && previouslyActiveBatchId !== batch.id) {
            capturedBlob = await stopMainRecording();
        }
        
        // Now, start the new recording. This is async and will clear old chunks after stop is complete.
        await startMainRecording();
        
        // After the physical recorder has started, update all state in one go.
        setActiveBatchId(batch.id);
        setBatches(prevBatches => {
            let newBatches = [...prevBatches];
    
            // 1. Update the batch that was just stopped (if any)
            if (capturedBlob && previouslyActiveBatchId) {
                newBatches = newBatches.map(b => 
                    b.id === previouslyActiveBatchId
                        ? { ...b, audioBlobs: [...b.audioBlobs, capturedBlob!], status: 'paused' }
                        : b
                );
            }
            
            // 2. Update the batch that is now recording
            newBatches = newBatches.map(b => 
                b.id === batch.id 
                    ? { ...b, status: 'recording' } 
                    : b
            );
            
            return newBatches;
        });
    
        setIsBusy(false);
    };
    
    const handlePause = async (batch: Batch) => {
        if (isBusy || !isMainRecording || activeBatchId !== batch.id) return;
        setIsBusy(true);
        
        const blob = await stopMainRecording();
        
        // Update state after recorder is stopped.
        setActiveBatchId(null);
        setBatches(prev => prev.map(b => 
            b.id === batch.id 
                ? { ...b, audioBlobs: [...b.audioBlobs, blob], status: 'paused' }
                : b
        ));
    
        setIsBusy(false);
    };
    
    const handleStop = async (batch: Batch) => {
        if (isBusy || !isMainRecording || activeBatchId !== batch.id) return;
        setIsBusy(true);
    
        const blob = await stopMainRecording();
        
        // Update state after recorder is stopped.
        setActiveBatchId(null);
        setBatches(prev => prev.map(b => 
            b.id === batch.id 
                ? { ...b, audioBlobs: [...b.audioBlobs, blob], status: 'complete' }
                : b
        ));
    
        setIsBusy(false);
    };
    
    const triggerUpload = (batchId: string) => {
        if (isMainRecording) return;
        setUploadTargetBatchId(batchId);
        fileInputRef.current?.click();
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file && uploadTargetBatchId) {
            setBatches(prev => prev.map(b => 
                b.id === uploadTargetBatchId 
                    ? { ...b, audioBlobs: [file], status: 'complete', findings: null, error: undefined } 
                    : b
            ));
            setUploadTargetBatchId(null);
        }
        if (event.target) event.target.value = "";
    };

    const handleProcessAll = async () => {
        const batchesToProcess = batches.filter(b => (b.status === 'complete' || b.status === 'paused') && b.audioBlobs.length > 0 && !b.findings);
        if (batchesToProcess.length === 0) return;

        setBatches(prev => prev.map(b => batchesToProcess.find(p => p.id === b.id) ? {...b, status: 'processing'} : b));

        await Promise.all(batchesToProcess.map(async (batch) => {
            if (batch.audioBlobs.length === 0) return;
            try {
                const mimeType = batch.audioBlobs[0].type;
                const mergedBlob = new Blob(batch.audioBlobs, { type: mimeType });
                const findings = await processAudio(mergedBlob, selectedModel);
                
                const chatSession = await createChat(mergedBlob, findings, selectedModel);
                const aiGreeting = "I have reviewed the audio and transcript for this dictation. How can I help you further?";
                const initialChatHistory = [{ author: 'AI' as const, text: `${findings.join('\n\n')}\n\n${aiGreeting}` }];

                setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, status: 'complete', findings, chat: chatSession, chatHistory: initialChatHistory, isChatting: false } : b));
            } catch (err) {
                 const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
                setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, status: 'error', error: errorMessage } : b));
            }
        }));
    };
    
    const handleReprocessBatch = async (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || batch.audioBlobs.length === 0) return;

        setBatches(prev => prev.map(b => b.id === batchId ? {...b, status: 'processing', error: undefined } : b));

        try {
            const mimeType = batch.audioBlobs[0].type;
            const mergedBlob = new Blob(batch.audioBlobs, { type: mimeType });
            const findings = await processAudio(mergedBlob, batch.selectedModel);
            
            const chatSession = await createChat(mergedBlob, findings, batch.selectedModel);
            const aiGreeting = "I have reviewed the audio and transcript for this dictation. How can I help you further?";
            const initialChatHistory = [{ author: 'AI' as const, text: `${findings.join('\n\n')}\n\n${aiGreeting}` }];

            setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'complete', findings, chat: chatSession, chatHistory: initialChatHistory, isChatting: false } : b));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'error', error: errorMessage, findings: null } : b));
        }
    };

    const handleSendMessage = async (batchId: string, message: string | Blob) => {
        const batchIndex = batches.findIndex(b => b.id === batchId);
        if (batchIndex === -1) return;

        const batch = batches[batchIndex];
        if (!batch.chat || batch.isChatting) return;

        const userMessageText = typeof message === 'string' ? message : '[Audio Message]';
        const updatedHistory = [...(batch.chatHistory || []), { author: 'You' as const, text: userMessageText }];
        
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, isChatting: true, chatHistory: updatedHistory } : b));

        try {
            let response;
            if (typeof message === 'string') {
                response = await batch.chat.sendMessage({ message });
            } else {
                const base64Audio = await blobToBase64(message);
                const audioPart = {
                    inlineData: { mimeType: getCleanMimeType(message), data: base64Audio },
                };
                const textPart = { text: "Please analyze this audio in the context of our conversation." };
                response = await batch.chat.sendMessage({ message: [audioPart, textPart] });
            }
            const responseText = response.text;
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, chatHistory: [...updatedHistory, { author: 'AI' as const, text: responseText }]} : b));
        } catch (err) {
            console.error("Chat error:", err);
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, chatHistory: [...updatedHistory, { author: 'AI' as const, text: `Sorry, I encountered an error: ${errorMessage}` }]} : b));
        } finally {
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, isChatting: false} : b));
        }
    };

    const handleUpdateFindingForBatch = (batchId: string, findingIndex: number, newText: string) => {
        setBatches(prevBatches => prevBatches.map(b => {
            if (b.id === batchId && b.findings) {
                const updatedFindings = [...b.findings];
                updatedFindings[findingIndex] = newText;
                return { ...b, findings: updatedFindings };
            }
            return b;
        }));
    };
    
    const showNotification = (text: string) => {
      setCopyNotification({ text, visible: true });
      setTimeout(() => setCopyNotification({ text: '', visible: false }), 2000);
    };

    const copyToClipboard = async (plainText: string, htmlText: string) => {
        try {
          const htmlBlob = new Blob([htmlText], { type: 'text/html' });
          const textBlob = new Blob([plainText], { type: 'text/plain' });
          const clipboardItem = new (window as any).ClipboardItem({
            'text/html': htmlBlob,
            'text/plain': textBlob,
          });
          await navigator.clipboard.write([clipboardItem]);
          return true;
        } catch (err) {
          console.error('Failed to copy rich text, falling back to plain text: ', err);
          try {
            await navigator.clipboard.writeText(plainText);
            return true;
          } catch (fallbackErr) {
            console.error('Failed to copy text with fallback: ', fallbackErr);
            return false;
          }
        }
    };

    const copyBatchSelection = async (batchId: string, selection: Set<number>) => {
      const batch = batches.find(b => b.id === batchId);
      if (!batch || !batch.findings) return;

      if (selection.size === 0) {
        showNotification('Selection cleared.');
        return;
      }

      const sortedIndices = Array.from(selection).sort((a, b) => a - b);
      
      const { plain, html } = sortedIndices.reduce((acc, i) => {
        const snippet = (selectionSnippets[batchId] || {})[i];
        if (snippet) {
          acc.plain.push(snippet);
          acc.html.push(`<strong>${snippet}</strong>`);
        } else {
          const finding = batch.findings![i];
          const { isStructured, title, points } = parseStructuredFinding(finding);
          if (isStructured) {
            acc.plain.push([title, ...points].join('\n'));
            acc.html.push(`<p><strong>${title}</strong></p>${points.map(p => `<p><strong>${p}</strong></p>`).join('')}`);
          } else {
            acc.plain.push(finding);
            acc.html.push(`<p><strong>${finding}</strong></p>`);
          }
        }
        return acc;
      }, { plain: [] as string[], html: [] as string[] });

      const plainText = plain.join('\n');
      const htmlText = html.join('');
      
      const success = await copyToClipboard(plainText, htmlText);
      const notificationText = success
        ? `Copied ${plain.length} finding${plain.length > 1 ? 's' : ''}!`
        : 'Copy failed!';
      showNotification(notificationText);
    };

    const handleMultiSelectToggleForBatch = (batchId: string, findingIndex: number) => {
        if (!multiSelectMode) {
            setMultiSelectMode(true);
            setCopier(null);

            const selection = window.getSelection();
            const selectedText = selection?.toString().trim();

            if (selection && selectedText && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const startNode = range.startContainer;
                const parentFindingItem = (startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as HTMLElement)?.closest('.finding-item');
                
                if (parentFindingItem) {
                    const selectedBatchId = parentFindingItem.getAttribute('data-batch-id');
                    const selectedIndexStr = parentFindingItem.getAttribute('data-finding-index');
                    if (selectedBatchId && selectedIndexStr) {
                        const selectedIndex = parseInt(selectedIndexStr, 10);
                        if (selectedBatchId === batchId && selectedIndex === findingIndex) {
                            setSelectionSnippets(prev => ({
                                ...prev,
                                [batchId]: {
                                ...(prev[batchId] || {}),
                                [findingIndex]: selectedText,
                                },
                            }));
                        }
                    }
                }
            }
        }
        const newSelections = { ...selections };
        const batchSelection = new Set(newSelections[batchId] || []);
        
        if (batchSelection.has(findingIndex)) {
            batchSelection.delete(findingIndex);
            setSelectionSnippets(prev => {
                const newBatchSnippets = { ...(prev[batchId] || {}) };
                delete newBatchSnippets[findingIndex];
                return { ...prev, [batchId]: newBatchSnippets };
            });
        } else {
            batchSelection.add(findingIndex);
        }
        newSelections[batchId] = batchSelection;
        setSelections(newSelections);
        copyBatchSelection(batchId, batchSelection);
    };

    const handleFindingClickForBatch = async (batchId: string, findingIndex: number) => {
        if (window.getSelection()?.toString().length) {
            return;
        }

        if (multiSelectMode) {
            handleMultiSelectToggleForBatch(batchId, findingIndex);
            return;
        }

        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;
        
        const findingToCopy = batch.findings[findingIndex];
        const { isStructured, title, points } = parseStructuredFinding(findingToCopy);

        let plainText: string;
        let htmlText: string;

        if (isStructured) {
            plainText = [title, ...points].join('\n');
            htmlText = `<p><strong>${title}</strong></p>${points.map(p => `<p><strong>${p}</strong></p>`).join('')}`;
        } else {
            plainText = findingToCopy;
            htmlText = `<p><strong>${findingToCopy}</strong></p>`;
        }

        const success = await copyToClipboard(plainText, htmlText);

        if (success) {
            setSelections({ [batchId]: new Set([findingIndex]) });
            setTimeout(() => setSelections({}), 500);
            showNotification('Copied!');
        } else {
            showNotification('Copy failed!');
        }
    };
    
    const handleSelectionHandleClickForBatch = (e: React.MouseEvent, batchId: string, findingIndex: number) => {
        e.stopPropagation();
        handleMultiSelectToggleForBatch(batchId, findingIndex);
    };


    const handleCopyAllForBatch = async (batch: Batch) => {
        if (!batch.findings || batch.findings.length === 0) return;
        const allTextPlain = batch.findings.map(f => {
            const { isStructured, title, points } = parseStructuredFinding(f);
            return isStructured ? [title, ...points].join('\n') : f;
        }).join('\n');

        const allTextHtml = batch.findings.map(f => {
            const { isStructured, title, points } = parseStructuredFinding(f);
            return isStructured
                ? `<p><strong>${title}</strong></p>${points.map(p => `<p><strong>${p}</strong></p>`).join('')}`
                : `<p><strong>${f}</strong></p>`;
        }).join('');

        const success = await copyToClipboard(allTextPlain, allTextHtml);
        if (success) {
          setAllCopiedId(batch.id);
          setTimeout(() => setAllCopiedId(null), 2000);
        }
    };

    const handleCopyAllBatches = async () => {
        const batchesWithFindings = batches.filter(b => b.findings && b.findings.length > 0);
        if (batchesWithFindings.length === 0) return;

        let allTextPlain = '';
        let allTextHtml = '';

        batchesWithFindings.forEach(b => {
            const name = b.name;
            const plainFindings = b.findings!.map(f => {
                const { isStructured, title, points } = parseStructuredFinding(f);
                return isStructured ? [title, ...points].join('\n') : f;
            }).join('\n');
            const htmlFindings = b.findings!.map(f => {
                const { isStructured, title, points } = parseStructuredFinding(f);
                return isStructured
                    ? `<p><strong>${title}</strong></p>${points.map(p => `<p><strong>${p}</strong></p>`).join('')}`
                    : `<p><strong>${f}</strong></p>`;
            }).join('');
            
            allTextPlain += `[${name}]\n${plainFindings}\n\n`;
            allTextHtml += `<h3>${name}</h3>` + htmlFindings;
        });

        const success = await copyToClipboard(allTextPlain.trim(), allTextHtml.trim());
        if (success) {
          setIsAllBatchesCopied(true);
          setTimeout(() => setIsAllBatchesCopied(false), 2000);
        }
    };


    const handleDownload = (batch: Batch) => {
        if (!batch.audioBlobs.length) return;
        try {
            const mimeType = batch.audioBlobs[0].type;
            const mergedBlob = new Blob(batch.audioBlobs, { type: mimeType });
            const url = URL.createObjectURL(mergedBlob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            const extension = mimeType === 'audio/mpeg' ? 'mp3' : (mimeType.split('/')[1] || 'webm').split(';')[0];
            a.download = `${batch.name.replace(/\s+/g, '_')}.${extension}`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
        } catch (err) {
            console.error('Failed to download audio:', err)
        }
    };

    const handleDownloadHTML = () => {
        const batchesWithFindings = batches.filter(b => b.findings && b.findings.length > 0);
        if (batchesWithFindings.length === 0) {
            showNotification("No processed transcripts to download.");
            return;
        };

        try {
            const htmlContent = generateBatchDictationHTML(batchesWithFindings);
            const blob = new Blob([htmlContent], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = 'batch-radiology-report.html';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
        } catch (err) {
            console.error('Failed to generate or download batch HTML:', err);
            showNotification("Failed to create HTML file.");
        }
    };

    // --- Batch Edit Mode Handlers ---
    const handleStartEdit = (batchId: string, index: number) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;
        
        setEditingState({ batchId, index });
        const { isStructured, title, points } = parseStructuredFinding(batch.findings[index]);
        const textForEditing = isStructured ? [title, ...points].join('\n') : batch.findings[index];
        setEditingText(textForEditing);

        setDictatingState(null);
        setDictateEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
    };

    const handleCancelEdit = () => {
        setEditingState(null);
        setEditingText('');
    };

    const handleSaveEdit = () => {
        if (editingState) {
            const batch = batches.find(b => b.id === editingState.batchId);
            if (batch && batch.findings) {
                const originalFinding = batch.findings[editingState.index];
                const { isStructured } = parseStructuredFinding(originalFinding);

                let newText = editingText;
                if (isStructured) {
                    newText = editingText.split('\n').filter(line => line.trim() !== '').join('###');
                }
                handleUpdateFindingForBatch(editingState.batchId, editingState.index, newText);
            }
        }
        handleCancelEdit();
    };

    const handleStartDictation = async (batchId: string, index: number) => {
        setEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
        setDictateEditingState(null);
        setDictatingState({ batchId, index });
        await startContinuationRecording();
    };

    const handleStopDictation = async () => {
        if (!dictatingState) return;

        const audioBlob = await stopContinuationRecording();
        const { batchId, index } = dictatingState;
        setDictatingState(null);

        const batch = batches.find(b => b.id === batchId);
        if (batch && batch.findings && audioBlob && audioBlob.size > 0) {
            setProcessingState({ batchId, index });
            try {
                const existingText = batch.findings[index];
                const newText = await continueAudioDictation(existingText, audioBlob);
                const separator = existingText.trim().length > 0 && !existingText.endsWith(' ') ? ' ' : '';
                const updatedText = existingText + separator + newText.trim();
                handleUpdateFindingForBatch(batchId, index, updatedText);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationError({ batchId, index, message });
            } finally {
                setProcessingState(null);
            }
        }
    };
    
    const handleStartDictateEditForBatch = async (batchId: string, index: number) => {
        setEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
        setDictatingState(null);
        setDictateEditingState({ batchId, index });
        await modifyRecorder.startRecording();
    };

    const handleStopDictateEditForBatch = async () => {
        if (!dictateEditingState) return;

        const audioBlob = await modifyRecorder.stopRecording();
        const { batchId, index } = dictateEditingState;
        setDictateEditingState(null);

        const batch = batches.find(b => b.id === batchId);
        if (batch && batch.findings && audioBlob && audioBlob.size > 0) {
            setProcessingState({ batchId, index });
            try {
                const existingText = batch.findings[index];
                const newText = await modifyFindingWithAudio(existingText, audioBlob);
                handleUpdateFindingForBatch(batchId, index, newText);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationError({ batchId, index, message });
            } finally {
                setProcessingState(null);
            }
        }
    };
    
    const handleCopyFromCopier = async (text: string) => {
      const success = await copyToClipboard(text, `<strong>${text}</strong>`);
      showNotification(success ? 'Copied selection!' : 'Copy failed!');
      setCopier(null);
    };

    const handleStartContinue = async (batchId: string) => {
        setContinuationState({ batchId, status: 'recording', error: null });
        await startBatchContinuation();
    };

    const handleStopContinue = async () => {
        if (!continuationState.batchId) return;

        const newAudioBlob = await stopBatchContinuation();
        const batchId = continuationState.batchId;

        if (newAudioBlob && newAudioBlob.size > 0) {
            setContinuationState({ batchId, status: 'processing', error: null });
            
            const batch = batches.find(b => b.id === batchId);
            if (!batch || !batch.findings) {
                 setContinuationState({ batchId, status: 'idle', error: "Original batch not found." });
                 return;
            }

            try {
                const newFindings = await processAudio(newAudioBlob, batch.selectedModel);
                const updatedFindings = [...batch.findings, ...newFindings];
                
                const updatedAudioBlobs = [...batch.audioBlobs, newAudioBlob];
                const mimeType = updatedAudioBlobs[0].type;
                const mergedBlob = new Blob(updatedAudioBlobs, { type: mimeType });

                const chatSession = await createChat(mergedBlob, updatedFindings, batch.selectedModel);
                const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
                const updatedChatHistory = [{ author: 'AI' as const, text: `${updatedFindings.join('\n\n')}\n\n${aiGreeting}` }];

                setBatches(prev => prev.map(b => b.id === batchId ? { 
                    ...b,
                    findings: updatedFindings,
                    audioBlobs: updatedAudioBlobs,
                    chat: chatSession,
                    chatHistory: updatedChatHistory,
                } : b));

                setContinuationState({ batchId: null, status: 'idle', error: null });

            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationState({ batchId, status: 'idle', error: message });
            }
        } else {
            setContinuationState({ batchId: null, status: 'idle', error: null });
        }
    };

    const allProcessed = batches.every(b => b.status !== 'processing');
    const hasProcessableRecordings = batches.some(b => (b.status === 'complete' || b.status === 'paused') && b.audioBlobs.length > 0 && !b.findings);
    const hasAnyResults = batches.some(b => b.findings);

    return (
        <div>
            {multiSelectMode && (
                <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-800 text-white rounded-full shadow-lg flex items-center gap-4 px-5 py-2 transition-all duration-300 ease-in-out">
                  <p className="text-sm font-semibold">Multi-select Mode</p>
                  <label htmlFor="multi-select-toggle-batch" className="flex items-center cursor-pointer">
                    <span className="mr-2 text-sm font-medium text-slate-300">OFF</span>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        id="multi-select-toggle-batch" 
                        className="sr-only peer" 
                        checked={multiSelectMode}
                        onChange={() => {
                          setMultiSelectMode(false);
                          setSelections({});
                          setSelectionSnippets({});
                        }}
                      />
                      <div className="w-12 h-6 bg-slate-600 rounded-full peer-checked:bg-blue-600"></div>
                      <div className="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform peer-checked:translate-x-6"></div>
                    </div>
                    <span className="ml-2 text-sm font-medium">ON</span>
                  </label>
                </div>
            )}
            {copier && copier.visible && (
                <SelectionCopier
                x={copier.x}
                y={copier.y}
                textToCopy={copier.text}
                onCopy={handleCopyFromCopier}
                onClose={() => setCopier(null)}
                />
            )}
            {copyNotification.visible && (
                <div className="fixed bottom-4 right-4 bg-slate-800 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-lg z-50 transition-all duration-300 ease-in-out" role="alert">
                {copyNotification.text}
                </div>
            )}
            <button onClick={onBack} className="text-sm text-blue-600 hover:underline mb-4 inline-block">&larr; Back to Single Dictation</button>
            <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept="audio/*" aria-hidden="true" />
            
            <div className="space-y-4">
                {batches.map((batch) => (
                        <div key={batch.id} className="p-4 border rounded-lg bg-slate-50 flex flex-col sm:flex-row items-center gap-4">
                            <div className="flex items-center gap-2 w-full sm:w-1/3">
                                <input
                                    type="text"
                                    value={batch.name}
                                    onChange={(e) => updateBatchName(batch.id, e.target.value)}
                                    className="font-semibold p-2 border rounded w-full"
                                    aria-label={`Batch name for ${batch.name}`}
                                />
                                <button
                                    onClick={() => removeBatch(batch.id)}
                                    className="p-2 text-slate-500 hover:text-red-600 rounded-full hover:bg-red-100 transition-colors flex-shrink-0"
                                    aria-label={`Remove batch ${batch.name}`}
                                >
                                    <TrashIcon className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="flex-grow flex items-center justify-center sm:justify-end gap-2">
                                {(batch.status === 'idle' || batch.status === 'paused' || batch.status === 'complete' || batch.status === 'error') && batch.findings === null && (
                                    <>
                                        <button onClick={() => handleRecordOrResume(batch)} className="flex items-center gap-2 bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition-colors text-sm px-3 disabled:bg-blue-300 disabled:cursor-wait" disabled={isBusy || (isMainRecording && activeBatchId !== batch.id)}>
                                            {batch.status === 'paused' ? <><ResumeIcon className="w-4 h-4"/> Resume</> : <><MicIcon className="w-4 h-4"/> Record</>}
                                        </button>
                                        <button onClick={() => triggerUpload(batch.id)} className="flex items-center gap-2 bg-slate-200 text-slate-700 p-2 rounded-lg hover:bg-slate-300 transition-colors text-sm px-3 disabled:bg-slate-100 disabled:cursor-wait" disabled={isMainRecording}>
                                            <UploadIcon className="w-4 h-4" /> Upload
                                        </button>
                                    </>
                                )}
                                {batch.status === 'recording' && (
                                    <>
                                        <button onClick={() => handlePause(batch)} className="flex items-center gap-2 bg-yellow-500 text-white p-2 rounded-lg hover:bg-yellow-600 transition-colors text-sm px-3 disabled:cursor-wait" disabled={isBusy}>
                                            <PauseIcon className="w-4 h-4" /> Pause
                                        </button>
                                        <button onClick={() => handleStop(batch)} className="flex items-center gap-2 bg-red-600 text-white p-2 rounded-lg hover:bg-red-700 transition-colors text-sm px-3 disabled:cursor-wait" disabled={isBusy}>
                                            <StopIcon className="w-4 h-4"/> Stop
                                        </button>
                                    </>
                                )}
                                {(batch.status === 'complete' || batch.status === 'paused') && batch.audioBlobs.length > 0 && batch.findings === null && <span className="text-green-600 font-semibold text-sm">Ready</span>}
                                {batch.status === 'processing' && <Spinner className="w-6 h-6" />}
                                {batch.status === 'error' && !batch.findings && <span className="text-red-600 font-semibold text-sm">Error</span>}
                                {batch.findings && <span className="text-blue-600 font-semibold text-sm">Processed</span>}
                            </div>
                        </div>
                    ))}
            </div>

            <div className="mt-6 flex flex-col sm:flex-row gap-4 flex-wrap">
                <button onClick={addBatch} className="bg-slate-200 text-slate-800 font-bold py-2 px-4 rounded-lg hover:bg-slate-300 w-full sm:w-auto">Add Dictation Batch</button>
                <button 
                    onClick={handleProcessAll}
                    disabled={!hasProcessableRecordings || !allProcessed || isBusy}
                    className="bg-green-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-green-700 disabled:bg-green-300 disabled:cursor-not-allowed w-full sm:w-auto flex-grow"
                >
                    {allProcessed ? 'Create All Transcripts' : <><Spinner className="w-5 h-5 inline mr-2" /> Processing...</>}
                </button>
                <button
                    onClick={handleDownloadHTML}
                    disabled={!hasAnyResults}
                    className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed w-full sm:w-auto"
                >
                    Download Report as HTML
                </button>
                <button
                    onClick={clearAllBatches}
                    disabled={batches.length === 0}
                    className="bg-red-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-red-700 w-full sm:w-auto disabled:bg-red-300"
                >
                    Clear All Batches
                </button>
            </div>
            
            {hasAnyResults && (
                <div ref={findingsContainerRef} className="mt-8 border-t pt-6">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-2xl font-bold text-slate-800">Processed Transcripts</h3>
                         <button
                            onClick={handleCopyAllBatches}
                            className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors ${isAllBatchesCopied ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}
                            >
                            {isAllBatchesCopied ? 'Copied!' : 'Copy All Transcripts'}
                        </button>
                    </div>
                     <div className="space-y-2">
                        {batches.filter(b => b.findings || (b.status === 'error' && b.findings === null)).map(batch => (
                             <div key={batch.id} className="border rounded-lg overflow-hidden">
                                <button onClick={() => setOpenAccordion(openAccordion === batch.id ? null : batch.id)} className="w-full text-left p-4 bg-slate-100 hover:bg-slate-200 flex justify-between items-center">
                                    <span className="font-semibold">{batch.name}</span>
                                    <span className={`transition-transform transform ${openAccordion === batch.id ? 'rotate-180' : ''}`}><ChevronDownIcon /></span>
                                </button>
                                {openAccordion === batch.id && (
                                     <div className="p-4 bg-white">
                                        {batch.status === 'processing' && batch.findings === null ? (
                                            <div className="text-center p-8">
                                                <Spinner />
                                                <p className="text-slate-600 mt-4 text-lg">
                                                Updating transcript...
                                                </p>
                                            </div>
                                        ) : batch.findings ? (
                                            <>
                                                <div className="flex justify-between items-center mb-4">
                                                  <h4 className="text-lg font-bold text-slate-800">Transcript</h4>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => handleCopyAllForBatch(batch)}
                                                            className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors ${allCopiedId === batch.id ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}
                                                        >
                                                            {allCopiedId === batch.id ? 'Copied!' : 'Copy All'}
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="bg-slate-100 p-3 rounded-lg mb-6 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
                                                    <div className="flex items-center gap-2 w-full sm:w-auto">
                                                        <label htmlFor={`model-select-${batch.id}`} className="text-sm font-medium text-slate-700 whitespace-nowrap">Process again with:</label>
                                                        <select 
                                                            id={`model-select-${batch.id}`}
                                                            value={batch.selectedModel}
                                                            onChange={(e) => updateBatchModel(batch.id, e.target.value)}
                                                            className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full"
                                                            aria-label="Select AI model for reprocessing"
                                                        >
                                                            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                                                            <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                                                            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                                                        </select>
                                                    </div>
                                                    <button
                                                        onClick={() => handleReprocessBatch(batch.id)}
                                                        className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0"
                                                        >
                                                        Update Transcript
                                                    </button>
                                                </div>
                                                <p className="text-slate-600 mb-6 text-sm">Click any finding to copy it. To select multiple, click the circle on the left. The 'Continue Dictation' button below adds new findings to this batch.</p>
                                                <div className="text-sm text-slate-500 mb-6 p-3 bg-slate-100 rounded-lg flex flex-col sm:flex-row gap-4 items-center">
                                                    <div className="flex items-center gap-2">
                                                        <MicPlusIcon className="w-5 h-5 flex-shrink-0" />
                                                        <span>Use this to <strong>append</strong> dictation.</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <MicPencilIcon className="w-5 h-5 flex-shrink-0" />
                                                        <span>Use this to <strong>dictate changes</strong>.</span>
                                                    </div>
                                                </div>
                                                <div className="space-y-3">
                                                    {batch.findings.map((finding, index) => {
                                                        const { isStructured, title, points } = parseStructuredFinding(finding);
                                                        const isSelected = selections[batch.id]?.has(index) ?? false;
                                                        const isEditingThis = editingState?.batchId === batch.id && editingState?.index === index;
                                                        const isDictatingThis = dictatingState?.batchId === batch.id && dictatingState?.index === index;
                                                        const isDictateEditingThis = dictateEditingState?.batchId === batch.id && dictateEditingState?.index === index;
                                                        const isProcessingThis = processingState?.batchId === batch.id && processingState?.index === index;
                                                        const hasErrorThis = continuationError?.batchId === batch.id && continuationError?.index === index;
                                                        const isCurrentlyActive = isEditingThis || isDictatingThis || isProcessingThis || hasErrorThis || isDictateEditingThis;

                                                        return (
                                                            <div
                                                                key={`${batch.id}-${index}`}
                                                                data-batch-id={batch.id}
                                                                data-finding-index={index}
                                                                className={`finding-item relative group p-3 pl-10 border-l-4 rounded-r-lg transition-all duration-200 ${
                                                                    isSelected && !isCurrentlyActive
                                                                    ? 'bg-blue-100 border-blue-600 shadow-md'
                                                                    : 'bg-slate-50 border-blue-500'
                                                                } ${!isCurrentlyActive ? 'hover:bg-blue-50' : ''}`}
                                                                role="button"
                                                                aria-pressed={isSelected && !isCurrentlyActive}
                                                                tabIndex={isCurrentlyActive ? -1 : 0}
                                                                onKeyDown={(e) => !isCurrentlyActive && (e.key === ' ' || e.key === 'Enter') && handleFindingClickForBatch(batch.id, index)}
                                                            >
                                                                 <div
                                                                    onClick={(e) => !isCurrentlyActive && handleSelectionHandleClickForBatch(e, batch.id, index)}
                                                                    className={`absolute left-0 top-0 bottom-0 w-8 flex items-center justify-center ${isCurrentlyActive ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                                                    role="checkbox"
                                                                    aria-checked={isSelected}
                                                                    aria-disabled={isCurrentlyActive}
                                                                    aria-label="Toggle selection for this finding"
                                                                 >
                                                                    <div className={`w-4 h-4 rounded-full border-2 transition-colors ${isSelected && !isCurrentlyActive ? 'bg-blue-600 border-blue-600' : 'border-slate-400 bg-white group-hover:border-blue-500'}`}></div>
                                                                 </div>
                                                                 
                                                                 {isEditingThis ? (
                                                                    <div className="flex flex-col gap-2">
                                                                        <textarea 
                                                                        value={editingText}
                                                                        onChange={(e) => setEditingText(e.target.value)}
                                                                        className="w-full p-2 border rounded-md font-semibold text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                                                        rows={Math.max(3, editingText.split('\n').length)}
                                                                        autoFocus
                                                                        />
                                                                        <div className="flex justify-end gap-2">
                                                                        <button onClick={handleCancelEdit} className="text-sm font-semibold py-1 px-3 rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300">Cancel</button>
                                                                        <button onClick={handleSaveEdit} className="text-sm font-semibold py-1 px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save</button>
                                                                        </div>
                                                                    </div>
                                                                ) : isProcessingThis ? (
                                                                    <div className="flex items-center gap-2">
                                                                        <Spinner className="w-5 h-5" />
                                                                        <p className="font-semibold text-slate-600">Processing...</p>
                                                                    </div>
                                                                ) : hasErrorThis ? (
                                                                    <div className="text-red-600">
                                                                        <p className="font-semibold">Error:</p>
                                                                        <p className="text-sm">{continuationError.message}</p>
                                                                        <button onClick={() => setContinuationError(null)} className="text-sm text-blue-600 hover:underline mt-1">Try again</button>
                                                                    </div>
                                                                ) : (
                                                                    <>
                                                                        <div
                                                                            className={`font-bold text-slate-700 ${!isCurrentlyActive ? 'cursor-pointer' : 'cursor-default'}`}
                                                                            onClick={() => !isCurrentlyActive && handleFindingClickForBatch(batch.id, index)}
                                                                        >
                                                                            {isStructured ? (
                                                                              <>
                                                                                <span>{title}</span>
                                                                                {points.map((point, i) => (<span key={i} className="block font-semibold">{point}</span>))}
                                                                              </>
                                                                            ) : (
                                                                              finding
                                                                            )}
                                                                        </div>
                                                                        {isDictatingThis ? (
                                                                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white p-1 rounded-full shadow-lg border border-slate-200">
                                                                                <div className="w-3 h-3 bg-red-500 rounded-full animate-ping ml-1"></div>
                                                                                <button onClick={handleStopDictation} aria-label="Stop dictation" className="p-1 text-slate-600 hover:text-red-600 rounded-full hover:bg-slate-200 transition-colors">
                                                                                    <StopIcon className="w-5 h-5" />
                                                                                </button>
                                                                            </div>
                                                                        ) : isDictateEditingThis ? (
                                                                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white p-1 rounded-full shadow-lg border border-slate-200">
                                                                                <div className="w-3 h-3 bg-blue-500 rounded-full animate-ping ml-1"></div>
                                                                                <button onClick={handleStopDictateEditForBatch} aria-label="Stop dictation edit" className="p-1 text-slate-600 hover:text-red-600 rounded-full hover:bg-slate-200 transition-colors">
                                                                                    <StopIcon className="w-5 h-5" />
                                                                                </button>
                                                                            </div>
                                                                        ) : (
                                                                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 p-1 rounded-md shadow-sm">
                                                                                <button onClick={() => handleStartEdit(batch.id, index)} aria-label="Edit text" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                                                                                    <PencilIcon />
                                                                                </button>
                                                                                <button onClick={() => handleStartDictation(batch.id, index)} aria-label="Append dictation" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                                                                                    <MicPlusIcon />
                                                                                </button>
                                                                                 <button onClick={() => handleStartDictateEditForBatch(batch.id, index)} aria-label="Dictate changes" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                                                                                    <MicPencilIcon />
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                <ChatInterface 
                                                    history={batch.chatHistory || []} 
                                                    isChatting={!!batch.isChatting} 
                                                    onSendMessage={(message) => handleSendMessage(batch.id, message)}
                                                />

                                                <div className="mt-8 pt-6 border-t flex flex-col sm:flex-row justify-center items-center gap-4 flex-wrap">
                                                    {continuationState.status === 'idle' && (
                                                        <>
                                                            <button
                                                                onClick={() => handleDownload(batch)}
                                                                className="bg-slate-500 text-white font-bold py-2 px-6 rounded-lg hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors w-full sm:w-auto"
                                                            >
                                                                Download Audio
                                                            </button>
                                                            <button
                                                                onClick={() => handleStartContinue(batch.id)}
                                                                className="bg-green-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto"
                                                            >
                                                                Continue Dictation
                                                            </button>
                                                        </>
                                                    )}
                                                    {continuationState.status === 'recording' && continuationState.batchId === batch.id && (
                                                        <div className="w-full flex items-center justify-center gap-4 bg-red-100 p-2 rounded-lg">
                                                            <div className="flex items-center gap-2">
                                                                <div className="w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
                                                                <span className="font-semibold text-red-700">Recording...</span>
                                                            </div>
                                                            <button
                                                                onClick={handleStopContinue}
                                                                className="flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-1 px-4 rounded-lg hover:bg-red-700"
                                                                aria-label="Stop continuing dictation"
                                                            >
                                                                <StopIcon className="w-5 h-5"/>
                                                                Stop
                                                            </button>
                                                        </div>
                                                    )}
                                                    {continuationState.status === 'processing' && continuationState.batchId === batch.id && (
                                                        <div className="w-full flex items-center justify-center gap-2 bg-slate-100 p-2 rounded-lg">
                                                            <Spinner className="w-6 h-6"/>
                                                            <span className="font-semibold text-slate-700">Processing...</span>
                                                        </div>
                                                    )}
                                                </div>
                                                {continuationState.error && continuationState.batchId === batch.id && (
                                                    <p className="text-center text-red-500 mt-4" role="alert">{continuationState.error}</p>
                                                )}
                                            </>
                                        ) : batch.status === 'error' && batch.error ? (
                                            <p className="text-red-600 p-4">{batch.error}</p>
                                        ) : null}
                                     </div>
                                )}
                            </div>
                        ))}
                     </div>
                </div>
            )}
        </div>
    );
};

export default BatchProcessor;