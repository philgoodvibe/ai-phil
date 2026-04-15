"use client";

import Script from "next/script";
import { useState } from "react";

export default function DiscoverPage() {
  const [started, setStarted] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-sage-beige/30 to-white">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/ai-phil-avatar.jpg"
            alt="AI Phil"
            className="mx-auto mb-6 h-20 w-20 rounded-full object-cover shadow-md ring-4 ring-sage-gold/50"
          />
          <h1 className="text-4xl font-bold text-sage-navy sm:text-5xl">
            Talk to AI Phil
          </h1>
          <p className="mt-4 text-lg text-gray-600">
            See if AIAI Mastermind is the right fit for your insurance agency.
            <br className="hidden sm:block" />
            Have a real conversation. No forms, no sales calls.
          </p>
        </div>

        {!started ? (
          <div className="mt-12 rounded-2xl border border-sage-navy/10 bg-white p-8 shadow-lg">
            <h2 className="text-xl font-semibold text-sage-navy">Before you start</h2>
            <ul className="mt-4 space-y-2 text-sm text-gray-700">
              <li className="flex gap-2"><span className="text-sage-coral">•</span>Find a quiet space — AI Phil speaks back.</li>
              <li className="flex gap-2"><span className="text-sage-coral">•</span>Allow microphone access when prompted.</li>
              <li className="flex gap-2"><span className="text-sage-coral">•</span>Prefer typing? Switch to Chat mode anytime inside the widget.</li>
              <li className="flex gap-2"><span className="text-sage-coral">•</span>Best for captive insurance agents (State Farm, Allstate, Farmers, etc.).</li>
            </ul>

            <button
              type="button"
              onClick={() => setStarted(true)}
              className="mt-6 w-full rounded-lg bg-sage-coral px-6 py-3 text-base font-semibold text-white shadow-md transition-all hover:scale-[1.02] hover:bg-sage-coral/90"
            >
              Start the conversation
            </button>
            <p className="mt-3 text-center text-xs text-gray-500">
              Powered by emotionally intelligent voice AI. Your conversation is private.
            </p>
          </div>
        ) : (
          <div className="mt-12 rounded-2xl border border-sage-navy/10 bg-white p-8 shadow-lg text-center">
            <p className="text-sm text-gray-700">
              AI Phil is ready. Look for the floating <strong>Talk to AI Phil</strong> button in the bottom-right corner.
            </p>
          </div>
        )}
      </div>

      {started && (
        <Script
          src="/ai-phil-embed.js"
          data-context="discovery"
          data-cta-label="Talk to AI Phil"
          strategy="afterInteractive"
        />
      )}
    </div>
  );
}
