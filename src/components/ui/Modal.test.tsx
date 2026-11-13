import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Modal, { ModalBody, ModalFooter, openModalFromTrigger } from './Modal';

function contents() {
  return (
    <>
      <ModalBody>
        <input aria-label="Name" />
        <button>Body action</button>
      </ModalBody>
      <ModalFooter>
        <button>Cancel</button>
        <button>Save</button>
      </ModalFooter>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Modal lifecycle', () => {
  it('focuses touch openers before mounting autofocus children, without scrolling', () => {
    const open = vi.fn(() => expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus());
    render(<button onClick={openModalFromTrigger(open)}>Open</button>);
    const opener = screen.getByRole('button', { name: 'Open' });
    const focus = vi.spyOn(opener, 'focus');
    fireEvent.click(opener);
    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('portals above app stacking contexts, locks scrolling and restores focus/styles', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'clip';
    const view = render(
      <Modal label="Edit" onClose={vi.fn()}>
        {contents()}
      </Modal>
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit' });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('textbox')).toHaveFocus();
    view.unmount();
    expect(document.body.style.overflow).toBe('clip');
    expect(opener).toHaveFocus();
    document.body.style.overflow = '';
    opener.remove();
  });

  it('traps current enabled controls in both directions and uses the latest close callback', () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const view = render(
      <Modal label="Edit" onClose={firstClose}>
        {contents()}
      </Modal>
    );
    const input = screen.getByRole('textbox');
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
    view.rerender(
      <Modal label="Edit" onClose={latestClose}>
        {contents()}
      </Modal>
    );
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: 'Escape' });
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledOnce();
  });

  it('preserves a WebKit-clamped scroll range and restores pre-existing padding on unlock', () => {
    document.body.style.paddingBottom = '8px';
    vi.spyOn(window, 'scrollY', 'get').mockReturnValueOnce(286).mockReturnValue(269);
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const view = render(
      <Modal label="Near page end" onClose={vi.fn()}>
        {contents()}
      </Modal>
    );
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 286);
    expect(document.body.style.paddingBottom).not.toBe('8px');
    view.unmount();
    expect(document.body.style.paddingBottom).toBe('8px');
    document.body.style.paddingBottom = '';
  });

  it('does not dismiss a pending write via Escape or backdrop', () => {
    const onClose = vi.fn();
    render(
      <Modal label="Busy" onClose={onClose} closeDisabled>
        {contents()}
      </Modal>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tracks keyboard resize AND visual viewport pan and removes both listeners', () => {
    const viewport = Object.assign(new EventTarget(), { height: 350, offsetTop: 40 });
    vi.stubGlobal('visualViewport', viewport);
    const remove = vi.spyOn(viewport, 'removeEventListener');
    const view = render(
      <Modal label="Keyboard" onClose={vi.fn()}>
        {contents()}
      </Modal>
    );
    const overlay = screen.getByRole('dialog').parentElement!;
    expect(overlay.style.height).toBe('350px');
    expect(overlay.style.top).toBe('40px');
    act(() => {
      viewport.height = 280;
      viewport.offsetTop = 75;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(overlay.style.height).toBe('280px');
    expect(overlay.style.top).toBe('75px');
    view.unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
