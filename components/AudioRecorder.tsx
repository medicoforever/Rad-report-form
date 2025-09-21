
import React, { useRef } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { AppStatus } from '../types';
import MicIcon from './icons/MicIcon';
import StopIcon from './icons/StopIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import UploadIcon from './icons/UploadIcon';

interface AudioRecorderProps {
  status: AppStatus;
  setStatus: (status: AppStatus) => void;
  onRecordingComplete: (audioBlob: Blob) => void;
}

const AudioRecorder: React.FC<AudioRecorderProps> = ({ status, setStatus, onRecordingComplete }) => {
  const { isRecording, isPaused, startRecording, stopRecording, pauseRecording, resumeRecording, error } = useAudioRecorder();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleStart = async () => {
    await startRecording();
    setStatus(AppStatus.Recording);
  };
  
  const handleStop = async () => {
    const audioBlob = await stopRecording();
    if (audioBlob) {
      onRecordingComplete(audioBlob);
    }
    // Status will be set to Processing by the parent component via onRecordingComplete
  };

  const handlePauseToggle = () => {
    if (isPaused) {
      resumeRecording();
    } else {
      pauseRecording();
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onRecordingComplete(file);
    }
    // Reset file input to allow selecting the same file again
    if(event.target) {
      event.target.value = "";
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const recordingText = isPaused ? 'Recording Paused' : 'Recording in Progress...';
  const recordingSubtext = isPaused ? 'Click the resume button to continue.' : 'Click the stop button when you are finished.';

  return (
    <div className="flex flex-col items-center justify-center p-4">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileSelect} 
        className="hidden" 
        accept="audio/*"
        aria-hidden="true"
      />
      <div className="relative mb-6">
        <div
          className={`absolute inset-0 rounded-full bg-blue-500 transition-transform duration-1000 ${
            isRecording && !isPaused ? 'animate-ping' : ''
          }`}
        ></div>
        <div className="relative w-24 h-24 rounded-full bg-white shadow-lg flex items-center justify-center">
            {isRecording ? <div className={`w-10 h-10 ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'} rounded-full`}></div> : <MicIcon />}
        </div>
      </div>
      <h2 className="text-2xl font-semibold text-slate-700 mb-2">
        {isRecording ? recordingText : 'Ready to Record'}
      </h2>
      <p className="text-slate-500 mb-6 text-center">
        {isRecording ? recordingSubtext : 'Click the button below to start recording your dictation or upload an audio file.'}
      </p>
      
      {error && <p className="text-red-500 mb-4">{error}</p>}
      
      {!isRecording ? (
        <div className="flex flex-col sm:flex-row items-center gap-4">
            <button
              onClick={handleStart}
              disabled={status === AppStatus.Recording}
              className="flex items-center justify-center gap-2 bg-blue-600 text-white font-bold py-3 px-8 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg"
              aria-label="Start Recording"
            >
              <MicIcon className="w-6 h-6"/>
              Start Recording
            </button>
            <span className="text-slate-500 my-2 sm:my-0">or</span>
            <button
              onClick={triggerFileSelect}
              className="flex items-center justify-center gap-2 bg-slate-200 text-slate-700 font-bold py-3 px-8 rounded-full hover:bg-slate-300 focus:outline-none focus:ring-4 focus:ring-slate-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg"
              aria-label="Upload Audio File"
            >
              <UploadIcon className="w-6 h-6"/>
              Upload Audio
            </button>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            onClick={handlePauseToggle}
            className={`flex items-center justify-center gap-2 font-bold py-3 px-8 rounded-full focus:outline-none focus:ring-4 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg ${
              isPaused 
                ? 'bg-green-500 text-white hover:bg-green-600 focus:ring-green-300' 
                : 'bg-yellow-500 text-white hover:bg-yellow-600 focus:ring-yellow-300'
            }`}
            aria-label={isPaused ? "Resume Recording" : "Pause Recording"}
          >
            {isPaused ? <ResumeIcon className="w-6 h-6"/> : <PauseIcon className="w-6 h-6"/>}
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={handleStop}
            disabled={!isRecording}
            className="flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-3 px-8 rounded-full hover:bg-red-700 focus:outline-none focus:ring-4 focus:ring-red-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg"
            aria-label="Stop Recording"
          >
            <StopIcon className="w-6 h-6"/>
            Stop Recording
          </button>
        </div>
      )}
    </div>
  );
};

export default AudioRecorder;
