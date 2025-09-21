import React, { useState, useEffect, useRef } from 'react';
import ChatInterface from './ChatInterface';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { continueAudioDictation, modifyFindingWithAudio } from '../services/geminiService';
import Spinner from './ui/Spinner';
import PencilIcon from './icons/PencilIcon';
import MicPlusIcon from './icons/MicPlusIcon';
import StopIcon from './icons/StopIcon';
import { generateSingleDictationHTML } from '../services/htmlGenerator';
import SelectionCopier from './ui/SelectionCopier';
import MicPencilIcon from './icons/MicPencilIcon';


interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

interface ResultsDisplayProps {
  findings: string[];
  onReset: () => void;
  audioBlob: Blob | null;
  chatHistory: ChatMessage[];
  isChatting: boolean;
  onSendMessage: (message: string | Blob) => void;
  onSwitchToBatch: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onReprocess: () => void;
  onUpdateFinding: (index: number, newText: string) => void;
  onContinueDictation: (audioBlob: Blob) => Promise<void>;
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

const ResultsDisplay: React.FC<ResultsDisplayProps> = ({ 
  findings, 
  onReset, 
  audioBlob, 
  chatHistory, 
  isChatting, 
  onSendMessage, 
  onSwitchToBatch,
  selectedModel,
  onModelChange,
  onReprocess,
  onUpdateFinding,
  onContinueDictation
}) => {
  const [isAllCopied, setIsAllCopied] = useState<boolean>(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [copyNotification, setCopyNotification] = useState<{ text: string; visible: boolean }>({ text: '', visible: false });
  const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);

  // State for Edit Mode
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [dictatingIndex, setDictatingIndex] = useState<number | null>(null);
  const [dictateEditingIndex, setDictateEditingIndex] = useState<number | null>(null);
  const [processingIndex, setProcessingIndex] = useState<number | null>(null);
  const [continuationError, setContinuationError] = useState<{ index: number; message: string } | null>(null);
  const appendRecorder = useAudioRecorder();
  const modifyRecorder = useAudioRecorder();
  const { startRecording: startAppendingRecording, stopRecording: stopAppendingRecording, error: appendRecorderError } = appendRecorder;
  const { startRecording: startModifyRecording, stopRecording: stopModifyRecording, error: modifyRecorderError } = modifyRecorder;

  // State for 'Continue Dictation' feature
  const continuationRecorder = useAudioRecorder();
  const { startRecording: startContinuingRecording, stopRecording: stopContinuingRecording, error: continueRecorderError } = continuationRecorder;
  const [continuationState, setContinuationState] = useState<{ status: 'idle' | 'recording' | 'processing'; error: string | null }>({ status: 'idle', error: null });


  // State for selection copier
  const [selectionSnippets, setSelectionSnippets] = useState<Record<number, string>>({});
  const [copier, setCopier] = useState<{ visible: boolean; x: number; y: number; text: string } | null>(null);
  const findingsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (appendRecorderError && dictatingIndex !== null) {
      setContinuationError({ index: dictatingIndex, message: appendRecorderError });
      setDictatingIndex(null);
    }
  }, [appendRecorderError, dictatingIndex]);

  useEffect(() => {
    if (modifyRecorderError && dictateEditingIndex !== null) {
      setContinuationError({ index: dictateEditingIndex, message: modifyRecorderError });
      setDictateEditingIndex(null);
    }
  }, [modifyRecorderError, dictateEditingIndex]);

  useEffect(() => {
    if (continueRecorderError) {
      setContinuationState({ status: 'idle', error: continueRecorderError });
    }
  }, [continueRecorderError]);

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // Small timeout to let click events fire first
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
          const indexStr = findingItem.getAttribute('data-finding-index');
          if (indexStr) {
            const index = parseInt(indexStr, 10);

            if (multiSelectMode) {
              setSelectionSnippets(prev => ({ ...prev, [index]: selectedText }));
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


  const showNotification = (text: string) => {
    setCopyNotification({ text, visible: true });
    setTimeout(() => setCopyNotification({ text: '', visible: false }), 2000);
  };
  
  const copyToClipboard = async (plainText: string, htmlText: string) => {
    try {
      const htmlBlob = new Blob([htmlText], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      // The type definition for ClipboardItem is not standard in all environments, so we use `any`
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

  const copySelection = async (indices: Set<number>) => {
    if (indices.size === 0) {
      showNotification('Selection cleared.');
      return;
    }

    const sortedIndices = Array.from(indices).sort((a, b) => a - b);
    
    const { plain, html } = sortedIndices.reduce((acc, i) => {
      const snippet = selectionSnippets[i];
      if (snippet) {
        acc.plain.push(snippet);
        acc.html.push(`<strong>${snippet}</strong>`);
      } else {
        const finding = findings[i];
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
  
  const handleMultiSelectToggle = (index: number) => {
    // Check if we are *entering* multi-select mode with a fresh text selection
    if (!multiSelectMode) {
      setMultiSelectMode(true);
      setCopier(null); // Hide copier when entering multi-select
      
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      
      if (selection && selectedText && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const startNode = range.startContainer;
        const parentFindingItem = (startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as HTMLElement)?.closest('.finding-item');
        
        if (parentFindingItem) {
            const selectedIndexStr = parentFindingItem.getAttribute('data-finding-index');
            if (selectedIndexStr) {
                const selectedIndex = parseInt(selectedIndexStr, 10);
                // If the current selection is on the item we are toggling, save the snippet.
                if (selectedIndex === index) {
                    setSelectionSnippets(prev => ({ ...prev, [index]: selectedText }));
                }
            }
        }
      }
    }

    const newSelectedIndices = new Set(selectedIndices);
    if (newSelectedIndices.has(index)) {
      newSelectedIndices.delete(index);
      // Remove snippet if deselecting
      setSelectionSnippets(prev => {
        const newSnippets = {...prev};
        delete newSnippets[index];
        return newSnippets;
      });
    } else {
      newSelectedIndices.add(index);
    }
    setSelectedIndices(newSelectedIndices);
    copySelection(newSelectedIndices);
  };
  
  const handleFindingClick = async (index: number) => {
    // Prevent single-copy if user is selecting text
    if (window.getSelection()?.toString().length) {
      return;
    }

    if (multiSelectMode) {
      handleMultiSelectToggle(index);
      return;
    }
    
    // Single-copy logic
    const findingToCopy = findings[index];
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
    
    if(success) {
      // Briefly highlight the copied item
      setSelectedIndices(new Set([index]));
      setTimeout(() => setSelectedIndices(new Set()), 500);
      showNotification('Copied!');
    } else {
      showNotification('Copy failed!');
    }
  };

  const handleSelectionHandleClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    handleMultiSelectToggle(index);
  };


  const handleCopyAll = async () => {
    if (!findings || findings.length === 0) return;
    
    const allTextPlain = findings.map(f => {
      const { isStructured, title, points } = parseStructuredFinding(f);
      return isStructured ? [title, ...points].join('\n') : f;
    }).join('\n');

    const allTextHtml = findings.map(f => {
      const { isStructured, title, points } = parseStructuredFinding(f);
      return isStructured
        ? `<p><strong>${title}</strong></p>${points.map(p => `<p><strong>${p}</strong></p>`).join('')}`
        : `<p><strong>${f}</strong></p>`;
    }).join('');


    const success = await copyToClipboard(allTextPlain, allTextHtml);
    if (success) {
        setIsAllCopied(true);
        setTimeout(() => setIsAllCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!audioBlob) return;
    try {
      const url = URL.createObjectURL(audioBlob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      
      const extension = audioBlob.type === 'audio/mpeg' ? 'mp3' : (audioBlob.type.split('/')[1] || 'webm').split(';')[0];
      a.download = `radiology-dictation.${extension}`;
      
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err) {
        console.error('Failed to download audio:', err)
    }
  };
  
  const handleRecordNew = () => {
    onReset();
  }

  const handleDownloadHTML = () => {
    if (!findings || findings.length === 0) return;
    try {
      const htmlContent = generateSingleDictationHTML(findings);
      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      a.download = 'radiology-report.html';
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err) {
      console.error('Failed to generate or download HTML:', err);
      showNotification('Failed to create HTML file.');
    }
  };

  // --- Edit Mode Handlers ---
  const handleStartEdit = (index: number) => {
    setEditingIndex(index);
    const { isStructured, title, points } = parseStructuredFinding(findings[index]);
    const textForEditing = isStructured ? [title, ...points].join('\n') : findings[index];
    setEditingText(textForEditing);
    setDictatingIndex(null);
    setDictateEditingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    setSelectedIndices(new Set());
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditingText('');
  };

  const handleSaveEdit = () => {
    if (editingIndex !== null) {
      const originalFinding = findings[editingIndex];
      const { isStructured } = parseStructuredFinding(originalFinding);

      let newText = editingText;
      if (isStructured) {
        newText = editingText.split('\n').filter(line => line.trim() !== '').join('###');
      }
      onUpdateFinding(editingIndex, newText);
    }
    handleCancelEdit();
  };

  const handleStartDictation = async (index: number) => {
    setEditingIndex(null);
    setDictateEditingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    setSelectedIndices(new Set());
    setDictatingIndex(index);
    await startAppendingRecording();
  };

  const handleStopDictation = async () => {
    if (dictatingIndex === null) return;

    const audioBlob = await stopAppendingRecording();
    const currentIndex = dictatingIndex;
    setDictatingIndex(null);

    if (audioBlob && audioBlob.size > 0) {
      setProcessingIndex(currentIndex);
      try {
        const existingText = findings[currentIndex];
        const newText = await continueAudioDictation(existingText, audioBlob);
        const separator = existingText.trim().length > 0 && !existingText.endsWith(' ') ? ' ' : '';
        const updatedText = existingText + separator + newText.trim();
        onUpdateFinding(currentIndex, updatedText);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unknown error occurred.';
        setContinuationError({ index: currentIndex, message });
      } finally {
        setProcessingIndex(null);
      }
    }
  };

  const handleStartDictateEdit = async (index: number) => {
    setEditingIndex(null);
    setDictatingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    setSelectedIndices(new Set());
    setDictateEditingIndex(index);
    await startModifyRecording();
  };

  const handleStopDictateEdit = async () => {
    if (dictateEditingIndex === null) return;

    const audioBlob = await stopModifyRecording();
    const currentIndex = dictateEditingIndex;
    setDictateEditingIndex(null);

    if (audioBlob && audioBlob.size > 0) {
        setProcessingIndex(currentIndex);
        try {
            const existingText = findings[currentIndex];
            const modifiedText = await modifyFindingWithAudio(existingText, audioBlob);
            onUpdateFinding(currentIndex, modifiedText);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setContinuationError({ index: currentIndex, message });
        } finally {
            setProcessingIndex(null);
        }
    }
  };

  const handleStartContinue = async () => {
    setContinuationState({ status: 'recording', error: null });
    await startContinuingRecording();
  };

  const handleStopContinue = async () => {
      const audioBlob = await stopContinuingRecording();
      if (audioBlob && audioBlob.size > 0) {
          setContinuationState({ status: 'processing', error: null });
          try {
              await onContinueDictation(audioBlob);
              setContinuationState({ status: 'idle', error: null });
          } catch (err) {
              const message = err instanceof Error ? err.message : 'An unknown error occurred.';
              setContinuationState({ status: 'idle', error: message });
          }
      } else {
          setContinuationState({ status: 'idle', error: null });
      }
  };
  
  const handleCopyFromCopier = async (text: string) => {
    const success = await copyToClipboard(text, `<strong>${text}</strong>`);
    showNotification(success ? 'Copied selection!' : 'Copy failed!');
    setCopier(null);
  };

  return (
    <div className="p-4">
      {multiSelectMode && (
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-800 text-white rounded-full shadow-lg flex items-center gap-4 px-5 py-2 transition-all duration-300 ease-in-out">
            <p className="text-sm font-semibold">Multi-select Mode</p>
            <label htmlFor="multi-select-toggle-single" className="flex items-center cursor-pointer">
              <span className="mr-2 text-sm font-medium text-slate-300">OFF</span>
              <div className="relative">
                <input 
                  type="checkbox" 
                  id="multi-select-toggle-single" 
                  className="sr-only peer" 
                  checked={multiSelectMode}
                  onChange={() => {
                    setMultiSelectMode(false);
                    setSelectedIndices(new Set());
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
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold text-slate-800">Corrected Findings</h2>
        {findings.length > 0 && (
          <button
            onClick={handleCopyAll}
            className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors ${isAllCopied ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}
          >
            {isAllCopied ? 'Copied!' : 'Copy All'}
          </button>
        )}
      </div>

      <div className="bg-slate-100 p-3 rounded-lg mb-6 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <label htmlFor="model-select-reprocess" className="text-sm font-medium text-slate-700 whitespace-nowrap">Process again with:</label>
          <select 
              id="model-select-reprocess"
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full"
              aria-label="Select AI model for reprocessing"
          >
              <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
          </select>
        </div>
        <button
            onClick={onReprocess}
            className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0"
          >
            Update Transcript
          </button>
      </div>

      <p className="text-slate-600 mb-6">Click any finding to copy it. To select multiple findings, click the circle on the left of each item. Use the 'Continue Dictation' button at the bottom to add more findings to this report.</p>
      <div className="text-sm text-slate-500 mb-6 p-3 bg-slate-100 rounded-lg flex flex-col sm:flex-row gap-4 items-center">
        <div className="flex items-center gap-2">
            <MicPlusIcon className="w-5 h-5 flex-shrink-0" />
            <span>Use this to <strong>append</strong> new dictation to the end of a finding.</span>
        </div>
        <div className="flex items-center gap-2">
            <MicPencilIcon className="w-5 h-5 flex-shrink-0" />
            <span>Use this to <strong>dictate changes</strong> or corrections to an existing finding.</span>
        </div>
      </div>
      <div ref={findingsContainerRef} className="space-y-3">
        {findings.map((finding, index) => {
          const { isStructured, title, points } = parseStructuredFinding(finding);
          const isSelected = selectedIndices.has(index);
          const isEditingThis = editingIndex === index;
          const isDictatingThis = dictatingIndex === index;
          const isDictateEditingThis = dictateEditingIndex === index;
          const isProcessingThis = processingIndex === index;
          const hasErrorThis = continuationError?.index === index;
          const isCurrentlyActive = isEditingThis || isDictatingThis || isProcessingThis || hasErrorThis || isDictateEditingThis;

          return (
            <div
              key={index}
              data-finding-index={index}
              className={`finding-item relative group p-3 pl-10 border-l-4 rounded-r-lg transition-all duration-200 ${
                  isSelected && !isCurrentlyActive
                  ? 'bg-blue-100 border-blue-600 shadow-md'
                  : 'bg-slate-50 border-blue-500'
              } ${!isCurrentlyActive ? 'hover:bg-blue-50' : ''}`}
              role="button"
              aria-pressed={isSelected && !isCurrentlyActive}
              tabIndex={isCurrentlyActive ? -1 : 0}
              onKeyDown={(e) => !isCurrentlyActive && (e.key === ' ' || e.key === 'Enter') && handleFindingClick(index)}
            >
              <div
                  onClick={(e) => !isCurrentlyActive && handleSelectionHandleClick(e, index)}
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
                    onClick={() => !isCurrentlyActive && handleFindingClick(index)}
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
                        <button onClick={handleStopDictateEdit} aria-label="Stop dictation edit" className="p-1 text-slate-600 hover:text-red-600 rounded-full hover:bg-slate-200 transition-colors">
                            <StopIcon className="w-5 h-5" />
                        </button>
                    </div>
                  ) : (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 p-1 rounded-md shadow-sm">
                      <button onClick={() => handleStartEdit(index)} aria-label="Edit text" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                        <PencilIcon />
                      </button>
                      <button onClick={() => handleStartDictation(index)} aria-label="Append dictation" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                        <MicPlusIcon />
                      </button>
                      <button onClick={() => handleStartDictateEdit(index)} aria-label="Dictate changes" className="p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors">
                        <MicPencilIcon />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      
      <ChatInterface 
        history={chatHistory} 
        isChatting={isChatting} 
        onSendMessage={onSendMessage} 
      />

      <div className="mt-8 pt-6 border-t flex flex-col sm:flex-row justify-center items-center gap-4 flex-wrap">
        {continuationState.status === 'idle' && (
          <>
            <button
              onClick={handleRecordNew}
              className="bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto"
            >
              Record New Dictation
            </button>
            <button
              onClick={onSwitchToBatch}
              className="bg-slate-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto"
            >
              Batch Processing
            </button>
             <button
              onClick={handleStartContinue}
              className="bg-green-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto"
            >
              Continue Dictation
            </button>
            <button
              onClick={handleDownload}
              disabled={!audioBlob}
              className="bg-slate-500 text-white font-bold py-2 px-6 rounded-lg hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              Download Audio
            </button>
            <button
              onClick={handleDownloadHTML}
              disabled={!findings || findings.length === 0}
              className="bg-green-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 transition-colors disabled:bg-green-300 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              Download as HTML
            </button>
          </>
        )}
        {continuationState.status === 'recording' && (
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
        {continuationState.status === 'processing' && (
            <div className="w-full flex items-center justify-center gap-2 bg-slate-100 p-2 rounded-lg">
                <Spinner className="w-6 h-6"/>
                <span className="font-semibold text-slate-700">Processing...</span>
            </div>
        )}
      </div>
      {continuationState.error && (
        <p className="text-center text-red-500 mt-4" role="alert">{continuationState.error}</p>
      )}
    </div>
  );
};

export default ResultsDisplay;