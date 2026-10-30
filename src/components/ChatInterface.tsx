import React, { useState, useEffect, useRef } from 'react';
import type { ChatMessage, AISettings } from '../types';
import { voiceService } from '../services/voiceService';
import { soundEffects } from '../utils/audioEffects';
import { QUICK_PROMPTS } from '../data/tvaLore';
import { Send, Mic, MicOff, Volume2, AlertOctagon, Terminal, Trash2 } from 'lucide-react';

interface ChatInterfaceProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  settings: AISettings;
  onQuickPrompt: (prompt: string) => void;
  onClearChat: () => void;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  messages,
  onSendMessage,
  isLoading,
  settings,
  onQuickPrompt,
  onClearChat,
}) => {
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of conversation
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;

    soundEffects.playKeyClick();
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleMicToggle = () => {
    soundEffects.playKeyClick();
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
    } else {
      setSpeechError(null);
      const rec = voiceService.startListening(
        (text: string, isFinal: boolean) => {
          setInputText(text);
          if (isFinal) {
            setIsListening(false);
            soundEffects.playTvaChime();
            onSendMessage(text);
            setInputText('');
          }
        },
        (err: string) => {
          setSpeechError(err);
          setIsListening(false);
        },
        () => {
          setIsListening(false);
        }
      );

      if (rec) {
        recognitionRef.current = rec;
        setIsListening(true);
      }
    }
  };

  const handleReplayVoice = (text: string) => {
    soundEffects.playKeyClick();
    voiceService.speak(text, {
      pitch: settings.voicePitch,
      rate: settings.voiceRate,
    });
  };

  return (
    <div className="bg-amber-950/40 border border-amber-600/30 rounded-2xl p-4 backdrop-blur-md shadow-2xl flex flex-col h-[520px] font-mono text-amber-200">
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between border-b border-amber-600/20 pb-2.5 mb-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-bold uppercase tracking-widest text-amber-300">
            TVA Terminal Log // Miss Minutes Interface
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-amber-500/80 uppercase">
            Protocol: {settings.provider.toUpperCase()}
          </span>
          <button
            onClick={onClearChat}
            className="text-amber-500/70 hover:text-amber-300 p-1 rounded transition-colors"
            title="Clear Terminal Log"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-amber-800">
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
          const isSystem = msg.sender === 'system';

          if (isSystem) {
            return (
              <div
                key={msg.id}
                className="my-2 p-2 bg-amber-900/20 border border-amber-600/30 rounded-lg text-center text-xs text-amber-300 flex items-center justify-center gap-2"
              >
                <AlertOctagon className="w-3.5 h-3.5 text-amber-400" />
                <span>{msg.text}</span>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} group`}
            >
              <div className="flex items-center gap-1.5 mb-1 text-[10px] text-amber-500/70">
                <span>{isUser ? 'VARIANT RECORD' : 'MISS MINUTES (AI)'}</span>
                <span>•</span>
                <span>{msg.timestamp}</span>
              </div>

              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed relative ${
                  isUser
                    ? 'bg-amber-600/30 border border-amber-500/40 text-amber-100 rounded-tr-none'
                    : 'bg-black/60 border border-amber-700/50 text-amber-200 rounded-tl-none shadow-md'
                } ${msg.nexusEventDetected ? 'border-red-500/70 bg-red-950/30' : ''}`}
              >
                {msg.nexusEventDetected && (
                  <div className="flex items-center gap-1 text-[10px] font-bold text-red-400 uppercase mb-1">
                    <AlertOctagon className="w-3 h-3 text-red-400 animate-pulse" />
                    Nexus Deviation Flagged
                  </div>
                )}

                <div className="whitespace-pre-wrap">{msg.text}</div>

                {/* Speak button for Miss Minutes messages */}
                {!isUser && (
                  <button
                    onClick={() => handleReplayVoice(msg.text)}
                    className="absolute bottom-1.5 right-2 opacity-0 group-hover:opacity-100 p-1 text-amber-400 hover:text-amber-200 transition-opacity"
                    title="Play Voice"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-amber-400 font-mono py-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            <span>Miss Minutes is accessing the TVA archives...</span>
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Speech Error Banner */}
      {speechError && (
        <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-700/40 px-2 py-1 rounded my-1">
          {speechError}
        </div>
      )}

      {/* Quick Prompt Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-2 scrollbar-none">
        {QUICK_PROMPTS.map((qp, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => onQuickPrompt(qp.prompt)}
            className="whitespace-nowrap px-2.5 py-1 text-[11px] bg-amber-950/60 hover:bg-amber-900/60 text-amber-300 hover:text-amber-100 border border-amber-700/40 rounded-full transition-all hover:scale-105"
          >
            {qp.label}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 pt-2 border-t border-amber-600/20">
        {/* Microphone Button */}
        <button
          type="button"
          onClick={handleMicToggle}
          className={`p-2.5 rounded-xl border transition-all ${
            isListening
              ? 'bg-red-600 text-white border-red-400 animate-pulse ring-2 ring-red-400'
              : 'bg-black/40 hover:bg-amber-900/30 text-amber-400 border-amber-700/40'
          }`}
          title={isListening ? 'Listening (Click to Stop)...' : 'Talk with Voice (Microphone)'}
        >
          {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        {/* Text Input */}
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={isListening ? 'Listening to your voice, sugar...' : 'Ask Miss Minutes anything or state your case...'}
          disabled={isLoading}
          className="flex-1 bg-black/60 border border-amber-600/40 rounded-xl px-3.5 py-2 text-xs text-amber-200 placeholder-amber-700/60 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/50"
        />

        {/* Send Button */}
        <button
          type="submit"
          disabled={!inputText.trim() || isLoading}
          className="p-2.5 bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold rounded-xl transition-all disabled:opacity-40 disabled:hover:bg-amber-500 cursor-pointer shadow-md"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
