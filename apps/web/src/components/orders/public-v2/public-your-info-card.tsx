'use client';

// "Your info" card in the request rail — restyled onto the storefront
// design system (sfp-* classes layered over sf tokens). Collects requester
// name/email/phone plus pickup notes; fulfillment type and the delivery
// site now live in the setup bar (public-orders-v2.tsx), mirroring the
// internal storefront. The off-screen honeypot anti-bot field stays here.

import { UserRound } from 'lucide-react';
import * as React from 'react';

import { useCart } from '@/components/orders/v2/cart-context';

interface PublicYourInfoCardProps {
  name: string;
  onNameChange: (v: string) => void;
  email: string;
  onEmailChange: (v: string) => void;
  phone: string;
  onPhoneChange: (v: string) => void;
  pickupNotes: string;
  onPickupNotesChange: (v: string) => void;
  hp: string;
  onHpChange: (v: string) => void;
}

export function PublicYourInfoCard({
  name,
  onNameChange,
  email,
  onEmailChange,
  phone,
  onPhoneChange,
  pickupNotes,
  onPickupNotesChange,
  hp,
  onHpChange,
}: PublicYourInfoCardProps) {
  const { state } = useCart();

  return (
    <div className="sfp-card">
      {/* Honeypot — rendered off-screen, never visible to real users */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-10000px',
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
      >
        <label htmlFor="pub-v2-hp">Website</label>
        <input
          type="text"
          id="pub-v2-hp"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(e) => onHpChange(e.target.value)}
        />
      </div>

      <div className="sfp-card-title">
        <UserRound size={15} /> Your info
      </div>

      <div className="sfp-row2">
        <div className="sfp-field">
          <label htmlFor="pub-v2-name">
            Name <span className="req">*</span>
          </label>
          <input
            id="pub-v2-name"
            className="sfp-input"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            autoComplete="name"
            maxLength={120}
            placeholder="Your full name"
          />
        </div>
        <div className="sfp-field">
          <label htmlFor="pub-v2-email">
            Email <span className="req">*</span>
          </label>
          <input
            id="pub-v2-email"
            className="sfp-input"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            autoComplete="email"
            maxLength={254}
            placeholder="you@example.com"
          />
        </div>
      </div>

      <div className="sfp-field">
        <label htmlFor="pub-v2-phone">
          Phone <span className="opt">Optional</span>
        </label>
        <input
          id="pub-v2-phone"
          className="sfp-input"
          type="tel"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          placeholder="(555) 123-4567"
          autoComplete="tel"
          maxLength={40}
        />
      </div>

      {state.fulfillmentType === 'pickup' && (
        <div className="sfp-field">
          <label htmlFor="pub-v2-pickup-notes">
            Pickup notes <span className="opt">Optional</span>
          </label>
          <textarea
            id="pub-v2-pickup-notes"
            className="sfp-textarea"
            value={pickupNotes}
            onChange={(e) => onPickupNotesChange(e.target.value)}
            placeholder="When you'll come by, who's picking up, etc."
            rows={2}
            maxLength={2000}
          />
        </div>
      )}
    </div>
  );
}
