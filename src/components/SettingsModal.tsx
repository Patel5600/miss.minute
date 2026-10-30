import React, { useState } from 'react';
import type { AISettings, AIProvider } from '../types';
import { AIService } from '../services/aiService';
import { soundEffects } from '../utils/audioEffects';
import { X, Key, Bot, Volume2, Sparkles, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (newSettings: AISettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
}) => {
  const [formData, setFormData] = useState<AISettings>({ ...settings });
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  if (!isOpen) return null;

  const handleProviderChange = (provider: AIProvider) => {
    let defaultModel = formData.model;
    if (provider === 'gemini') defaultModel = 'gemini-1.5-flash';
    else if (provider === 'openai') defaultModel = 'gpt-4o-mini';
    else if (provider === 'anthropic') defaultModel = 'claude-3-5-sonnet-20241022';
    else if (provider === 'ollama') defaultModel = 'llama3';

    setFormData(prev => ({
      ...prev,
      provider,
      model: defaultModel,
    }));
    soundEffects.playKeyClick();
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('Testing temporal connection...');
    soundEffects.playKeyClick();

    try {
      const res = await AIService.generateResponse('Hello Miss Minutes!', [], formData);
      setTestStatus('success');
      setTestMessage(`Connection Verified! Response: "${res.text.slice(0, 60)}..."`);
      soundEffects.playTvaChime();
    } catch (err: any) {
      setTestStatus('error');
      setTestMessage(err?.message || 'Connection failed. Check your API key or endpoint.');
    }
  };

  const handleSaveAndClose = () => {
    AIService.saveSettings(formData);
    onSave(formData);
    soundEffects.playTvaChime();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-xl bg-neutral-900 border-2 border-amber-600/50 rounded-2xl shadow-[0_0_50px_rgba(245,158,11,0.2)] p-6 font-mono text-amber-200 max-h-[90vh] overflow-y-auto">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-amber-400 hover:text-amber-100 bg-amber-950/40 hover:bg-amber-900/60 rounded-lg border border-amber-700/40 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2.5 mb-5 border-b border-amber-600/20 pb-3">
          <Bot className="w-6 h-6 text-amber-400" />
          <div>
            <h2 className="text-lg font-bold text-amber-300 uppercase tracking-wide">
              TVA Neural Link & AI Pair Configuration
            </h2>
            <p className="text-xs text-amber-400/70">
              Connect Miss Minutes to Gemini, ChatGPT, Claude, Ollama, or Offline TVA Hologram
            </p>
          </div>
        </div>

        {/* Provider Selector Tabs */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">
            AI Provider Selection
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[
              { id: 'tva-offline', label: '🕒 TVA Offline', desc: 'Zero API keys required' },
              { id: 'gemini', label: '✨ Google Gemini', desc: 'Fast & responsive' },
              { id: 'openai', label: '🟢 OpenAI / ChatGPT', desc: 'GPT-4o / GPT-4o-mini' },
              { id: 'anthropic', label: '🟣 Anthropic Claude', desc: 'Sonnet 3.5' },
              { id: 'ollama', label: '🦙 Ollama / Local AI', desc: 'localhost:11434' },
            ].map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleProviderChange(p.id as AIProvider)}
                className={`p-2.5 rounded-xl border text-left flex flex-col transition-all ${
                  formData.provider === p.id
                    ? 'border-amber-400 bg-amber-600/20 shadow-md text-amber-100 ring-1 ring-amber-400'
                    : 'border-amber-900/50 bg-black/40 text-amber-300/70 hover:border-amber-700/60'
                }`}
              >
                <span className="font-semibold text-xs">{p.label}</span>
                <span className="text-[10px] text-amber-400/50 mt-0.5">{p.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* API Key and Model Inputs (if not offline) */}
        {formData.provider !== 'tva-offline' && (
          <div className="space-y-3 p-3.5 bg-black/40 rounded-xl border border-amber-700/30 mb-4">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-amber-400 uppercase mb-1">
                <Key className="w-3.5 h-3.5 text-amber-400" />
                {formData.provider === 'gemini'
                  ? 'Gemini API Key'
                  : formData.provider === 'openai'
                  ? 'OpenAI API Key'
                  : formData.provider === 'anthropic'
                  ? 'Anthropic API Key'
                  : 'Bearer Token (Optional for Ollama)'}
              </label>
              <input
                type="password"
                placeholder="Enter your API Key..."
                value={formData.apiKey}
                onChange={e => setFormData({ ...formData, apiKey: e.target.value })}
                className="w-full bg-neutral-950 border border-amber-600/50 rounded-lg px-3 py-2 text-xs text-amber-200 placeholder-amber-700/50 focus:outline-none focus:border-amber-400"
              />
              <span className="text-[10px] text-amber-500/70 mt-1 block">
                Keys are stored only in your local browser storage and never uploaded to any third party.
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-amber-400 uppercase mb-1">
                  Model Designation
                </label>
                <input
                  type="text"
                  value={formData.model}
                  onChange={e => setFormData({ ...formData, model: e.target.value })}
                  placeholder="e.g. gemini-1.5-flash, gpt-4o-mini"
                  className="w-full bg-neutral-950 border border-amber-600/50 rounded-lg px-3 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-amber-400"
                />
              </div>

              {formData.provider === 'ollama' && (
                <div>
                  <label className="block text-xs font-bold text-amber-400 uppercase mb-1">
                    Custom Endpoint
                  </label>
                  <input
                    type="text"
                    value={formData.customEndpoint || ''}
                    onChange={e => setFormData({ ...formData, customEndpoint: e.target.value })}
                    placeholder="http://localhost:11434/v1"
                    className="w-full bg-neutral-950 border border-amber-600/50 rounded-lg px-3 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-amber-400"
                  />
                </div>
              )}
            </div>

            {/* Test Connection Button */}
            <div className="pt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testStatus === 'testing'}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 rounded-lg border border-amber-500/50 text-xs transition-colors disabled:opacity-50"
              >
                {testStatus === 'testing' ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Verifying...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Test Connection
                  </>
                )}
              </button>

              {testStatus === 'success' && (
                <div className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-4 h-4" /> Connected
                </div>
              )}
              {testStatus === 'error' && (
                <div className="flex items-center gap-1 text-xs text-red-400 font-semibold">
                  <AlertCircle className="w-4 h-4" /> Failed
                </div>
              )}
            </div>

            {testMessage && (
              <p className={`text-[11px] p-2 rounded ${
                testStatus === 'success' ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300'
              }`}>
                {testMessage}
              </p>
            )}
          </div>
        )}

        {/* ── ElevenLabs Voice Engine ── */}
        <div className="mb-4 p-3.5 bg-black/40 rounded-xl border border-amber-700/30 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-amber-300 block">🎙️ ElevenLabs Realistic Voice</span>
              <span className="text-[10px] text-amber-400/60">High-quality, natural AI voice (optional). Get a free key at elevenlabs.io</span>
            </div>
            <input type="checkbox"
              checked={!!formData.useElevenLabs}
              onChange={e => setFormData({ ...formData, useElevenLabs: e.target.checked })}
              className="w-4 h-4 accent-amber-500 rounded cursor-pointer"/>
          </div>

          {formData.useElevenLabs && (
            <div className="space-y-2">
              <div>
                <label className="block text-[10px] text-amber-500 uppercase font-bold mb-1">ElevenLabs API Key</label>
                <input type="password" placeholder="xi-..."
                  value={formData.elevenLabsKey || ''}
                  onChange={e => setFormData({ ...formData, elevenLabsKey: e.target.value })}
                  className="w-full bg-neutral-950 border border-amber-600/50 rounded-lg px-3 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-amber-400"/>
              </div>
              <div>
                <label className="block text-[10px] text-amber-500 uppercase font-bold mb-1">Voice Character</label>
                <select
                  value={formData.elevenLabsVoiceId || 'EXAVITQu4vr4xnSDxMaL'}
                  onChange={e => setFormData({ ...formData, elevenLabsVoiceId: e.target.value })}
                  className="w-full bg-neutral-950 border border-amber-600/50 rounded-lg px-3 py-1.5 text-xs text-amber-200 focus:outline-none">
                  <option value="EXAVITQu4vr4xnSDxMaL">Bella – Warm & Expressive (Recommended)</option>
                  <option value="ThT5KcBeYPX3keUQqHPh">Dorothy – Sweet Southern Charm</option>
                  <option value="MF3mGyEYCl7XYWbV9V6O">Elli – Friendly & Animated</option>
                  <option value="21m00Tcm4TlvDq8ikWAM">Rachel – Clear & Professional</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Audio & Hologram Toggles */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 bg-black/40 rounded-xl border border-amber-700/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-amber-400" />
              <div>
                <span className="text-xs font-bold text-amber-200 block">Voice (TTS)</span>
                <span className="text-[10px] text-amber-400/60">Southern voice synthesis</span>
              </div>
            </div>
            <input
              type="checkbox"
              checked={formData.voiceEnabled}
              onChange={e => setFormData({ ...formData, voiceEnabled: e.target.checked })}
              className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
            />
          </div>

          <div className="p-3 bg-black/40 rounded-xl border border-amber-700/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <div>
                <span className="text-xs font-bold text-amber-200 block">Hologram FX</span>
                <span className="text-[10px] text-amber-400/60">CRT scanlines & beam</span>
              </div>
            </div>
            <input
              type="checkbox"
              checked={formData.hologramMode}
              onChange={e => setFormData({ ...formData, hologramMode: e.target.checked })}
              className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
            />
          </div>
        </div>

        {/* System Prompt Customization */}
        <div className="mb-5">
          <label className="block text-xs font-bold text-amber-400 uppercase mb-1">
            Miss Minutes TVA Persona Prompt
          </label>
          <textarea
            rows={4}
            value={formData.systemPrompt}
            onChange={e => setFormData({ ...formData, systemPrompt: e.target.value })}
            className="w-full bg-neutral-950 border border-amber-600/40 rounded-lg p-2.5 text-xs text-amber-200/90 focus:outline-none focus:border-amber-400 font-mono resize-none leading-relaxed"
          />
        </div>

        {/* Footer Buttons */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-amber-600/20">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs text-amber-300 hover:text-amber-100 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveAndClose}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-neutral-950 shadow-lg shadow-amber-500/20 transition-all transform hover:scale-105"
          >
            Save & Connect Link
          </button>
        </div>
      </div>
    </div>
  );
};
