'use client';

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface ModalProps {
  label: string;
  onClose: () => void;
  closeDisabled?: boolean;
  sheet?: boolean;
  className?: string;
  children: ReactNode;
}

const focusableSelector =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

// One portal shell for every application dialog/sheet. Native confirm/alert windows
// are browser-owned and intentionally do not participate in application stacking.
export default function Modal({
  label,
  onClose,
  closeDisabled = false,
  sheet = false,
  className,
  children,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Capture before React mounts any autoFocus child, not in the mount effect.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : document.activeElement
  );

  useEffect(() => {
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children)
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay)
      .map((node) => ({ node, inert: node.inert }));
    siblings.forEach(({ node }) => {
      node.inert = true;
    });

    const viewport = window.visualViewport;
    const updateViewport = () => {
      if (!viewport) return; // CSS uses 100dvh, preceded by the 100vh fallback.
      overlay.style.height = `${viewport.height}px`;
      overlay.style.top = `${viewport.offsetTop}px`;
    };
    updateViewport();
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    if (!panel.contains(document.activeElement)) {
      (panel.querySelector<HTMLElement>(focusableSelector) ?? panel).focus({ preventScroll: true });
    }
    return () => {
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      siblings.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (node) => node.tabIndex >= 0 && !node.closest('[hidden], [inert]')
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
      } else if (!panel.contains(document.activeElement) || document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, closeDisabled]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={overlayRef}
      className={cn('modal-overlay', sheet && 'modal-overlay-sheet')}
      onClick={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn('modal-panel', sheet && 'modal-panel-sheet', className)}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('modal-body', className)} {...props} />;
}

export function ModalFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('modal-footer', className)} {...props} />;
}
