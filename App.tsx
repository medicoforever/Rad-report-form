
import React, { useState, useCallback, useEffect } from 'react';
import AudioRecorder from './components/AudioRecorder';
import ResultsDisplay from './components/ResultsDisplay';
import { AppStatus } from './types';
import { processAudio, createChat, blobToBase64, base64ToBlob } from './services/geminiService';
import Spinner from './components/ui/Spinner';
import { Chat } from '@google/genai';
import BatchProcessor from './components/BatchProcessor';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

const SINGLE_MODE_STORAGE_KEY = 'radiologyDictationSingleMode';

const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if (!mimeType) {
        // Fallback for files without a MIME type, maintaining original behavior.
        return 'audio/ogg';
    }
    // Handle WebM variations. It can be audio/webm or video/webm for audio-only files.
    // Also, strip codec information which might not be supported by the API.
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    // For other types, just strip potential codec/parameter info
    return mimeType.split(';')[0];
};

const App: React.FC = () => {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [status, setStatus] = useState<AppStatus>(AppStatus.Idle);
  const [findings, setFindings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>('gemini-2.5-pro');

  // Load state from localStorage on initial render
  useEffect(() => {
    try {
      const savedStateJSON = localStorage.getItem(SINGLE_MODE_STORAGE_KEY);
      if (savedStateJSON) {
        const savedState = JSON.parse(savedStateJSON);
        if (savedState.findings && savedState.findings.length > 0 && savedState.audio) {
          const blob = base64ToBlob(savedState.audio.data, savedState.audio.type);
          setFindings(savedState.findings);
          setAudioBlob(blob);
          setChatHistory(savedState.chatHistory || []);
          setStatus(AppStatus.Success);
          
          const modelToUse = savedState.selectedModel || 'gemini-2.5-pro';
          setSelectedModel(modelToUse);

          // Recreate chat session asynchronously
          createChat(blob, savedState.findings, modelToUse)
            .then(setChat)
            .catch(err => console.error("Failed to recreate chat session from saved state:", err));
        }
      }
    } catch (err) {
      console.error("Failed to load state from localStorage:", err);
      localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
    }
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    const saveState = async () => {
      // Only save when we have a successful result to resume from
      if (status === AppStatus.Success && findings.length > 0 && audioBlob) {
        try {
          const audio = {
            data: await blobToBase64(audioBlob),
            type: getCleanMimeType(audioBlob),
          };
          const stateToSave = {
            findings,
            audio,
            chatHistory,
            selectedModel,
          };
          localStorage.setItem(SINGLE_MODE_STORAGE_KEY, JSON.stringify(stateToSave));
        } catch (err) {
          console.error("Failed to save state to localStorage:", err);
        }
      }
    };
    saveState();
  }, [status, findings, audioBlob, chatHistory, selectedModel]);


  const handleRecordingComplete = useCallback(async (audioBlob: Blob) => {
    if (!audioBlob || audioBlob.size === 0) {
      setError('Recording or upload failed. The audio file is empty.');
      setStatus(AppStatus.Error);
      return;
    }
    setStatus(AppStatus.Processing);
    setError(null);
    setFindings([]);

    try {
      const processedText = await processAudio(audioBlob, selectedModel);
      setFindings(processedText);
      setAudioBlob(audioBlob);

      const chatSession = await createChat(audioBlob, processedText, selectedModel);
      setChat(chatSession);
      const aiGreeting = "I have reviewed the audio and the transcript. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);
      
      setStatus(AppStatus.Success);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during processing.');
      setStatus(AppStatus.Error);
    }
  }, [selectedModel]);
  
  const handleReprocess = useCallback(async () => {
    if (!audioBlob) {
      setError('No audio available to reprocess.');
      setStatus(AppStatus.Error);
      return;
    }
    // This re-uses the main processing logic with the current `selectedModel`
    await handleRecordingComplete(audioBlob);
  }, [audioBlob, handleRecordingComplete]);

  const handleUpdateFinding = (index: number, newText: string) => {
    setFindings(prevFindings => {
      const updatedFindings = [...prevFindings];
      if (updatedFindings[index] !== undefined) {
        updatedFindings[index] = newText;
      }
      return updatedFindings;
    });
  };

  const handleContinueDictation = useCallback(async (newAudioBlob: Blob) => {
    if (!audioBlob) {
      throw new Error('Original audio not found. Cannot continue dictation.');
    }

    try {
      const newFindings = await processAudio(newAudioBlob, selectedModel);
      const updatedFindings = [...findings, ...newFindings];
      setFindings(updatedFindings);

      const mergedBlob = new Blob([audioBlob, newAudioBlob], { type: getCleanMimeType(audioBlob) });
      setAudioBlob(mergedBlob);
      
      const chatSession = await createChat(mergedBlob, updatedFindings, selectedModel);
      setChat(chatSession);

      const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${updatedFindings.join('\n\n')}\n\n${aiGreeting}` }]);

    } catch (err) {
      console.error("Error during dictation continuation:", err);
      throw err; // Propagate error to the UI component
    }
  }, [audioBlob, findings, selectedModel]);

  const handleSendMessage = async (message: string | Blob) => {
    if (!chat || isChatting) return;

    setIsChatting(true);
    const userMessageText = typeof message === 'string' ? message : '[Audio Message]';
    setChatHistory(prev => [...prev, { author: 'You', text: userMessageText }]);

    try {
      let response;
      if (typeof message === 'string') {
        response = await chat.sendMessage({ message });
      } else { // It's a Blob
        const base64Audio = await blobToBase64(message);
        const audioPart = {
          inlineData: {
            mimeType: getCleanMimeType(message),
            data: base64Audio,
          },
        };
        // Adding a text part to guide the model.
        const textPart = { text: "Please analyze this audio in the context of our conversation." };
        // The `message` property can be an array of parts for multipart messages.
        response = await chat.sendMessage({ message: [audioPart, textPart] });
      }
      const responseText = response.text;
      setChatHistory(prev => [...prev, { author: 'AI', text: responseText }]);
    } catch (err) {
      console.error("Chat error:", err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setChatHistory(prev => [...prev, { author: 'AI', text: `Sorry, I encountered an error: ${errorMessage}` }]);
    } finally {
      setIsChatting(false);
    }
  };

  const resetSingleMode = () => {
    setStatus(AppStatus.Idle);
    setFindings([]);
    setError(null);
    setAudioBlob(null);
    setChat(null);
    setChatHistory([]);
    setIsChatting(false);
    // Clear saved state on reset
    try {
      localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
    } catch (error) {
      console.error("Failed to remove item from localStorage:", error);
    }
  };

  const renderSingleModeContent = () => {
    switch (status) {
      case AppStatus.Idle:
      case AppStatus.Recording:
        return (
          <>
            <div className="text-right mb-4 -mt-4">
                 <button 
                    onClick={() => setMode('batch')} 
                    className="text-sm font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                >
                    Switch to Batch Processing &rarr;
                </button>
            </div>
            <AudioRecorder
              status={status}
              setStatus={setStatus}
              onRecordingComplete={handleRecordingComplete}
            />
          </>
        );
      case AppStatus.Processing:
        return (
          <div className="text-center p-8">
            <Spinner />
            <p className="text-slate-600 mt-4 text-lg">
              Analyzing audio and correcting text...
            </p>
            <p className="text-slate-500 mt-2 text-sm">
              This may take a moment.
            </p>
          </div>
        );
      case AppStatus.Success:
        return (
          <ResultsDisplay 
            findings={findings} 
            onReset={resetSingleMode} 
            audioBlob={audioBlob}
            chatHistory={chatHistory}
            isChatting={isChatting}
            onSendMessage={handleSendMessage}
            onSwitchToBatch={() => setMode('batch')}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onReprocess={handleReprocess}
            onUpdateFinding={handleUpdateFinding}
            onContinueDictation={handleContinueDictation}
          />
        );
      case AppStatus.Error:
        return (
          <div className="text-center p-8 bg-red-50 border border-red-200 rounded-lg">
            <h3 className="text-xl font-semibold text-red-700">An Error Occurred</h3>
            <p className="text-red-600 mt-2">{error}</p>
            <button
              onClick={resetSingleMode}
              className="mt-6 bg-red-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50 transition-colors"
            >
              Try Again
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  const renderContent = () => {
    switch (mode) {
      case 'single':
        return renderSingleModeContent();
      case 'batch':
        return <BatchProcessor selectedModel={selectedModel} onBack={() => {
          resetSingleMode();
          setMode('single');
        }} />;
      default:
        return renderSingleModeContent();
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-3xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-800">Radiology Dictation Corrector</h1>
          <p className="text-slate-600 mt-2">
            {mode === 'single' && 'Record your findings, and let AI provide a clean, corrected transcript.'}
            {mode === 'batch' && 'Manage and transcribe multiple dictations efficiently.'}
          </p>
           {status === AppStatus.Idle && (
             <div className="mt-4 flex justify-center items-center gap-2">
                <label htmlFor="model-select" className="text-sm font-medium text-slate-700">AI Model:</label>
                <select 
                    id="model-select"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2"
                >
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                </select>
             </div>
           )}
        </header>
        <main className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 min-h-[300px]">
          {renderContent()}
        </main>
        <footer className="text-center mt-8 text-sm text-slate-500">
          <p>Powered by Gemini AI</p>
        </footer>
      </div>
    </div>
  );
};

export default App;
