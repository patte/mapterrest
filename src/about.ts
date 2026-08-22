import aboutHtml from './about.md';
import { readBoolean, write } from './urlState';

/** The About pill's dialog. Its text lives in about.md; edits land on the next build. */
export type About = {
  /** For hash edits — applies without writing the hash back. */
  setOpen(on: boolean): void;
};

export function setupAbout(): About {
  const dialog = document.getElementById('about-dialog') as HTMLDialogElement;
  document.getElementById('about-body')!.innerHTML = aboutHtml;

  document.getElementById('about-open')!.addEventListener('click', () => {
    dialog.showModal();
    write('about', true);
  });
  document.getElementById('about-close')!.addEventListener('click', () => dialog.close());
  // The content owns all of the dialog's box, so a click targeting the dialog itself
  // landed on the backdrop. Esc already closes natively.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  // Every way out — X, backdrop, Esc — funnels through 'close', so the hash follows.
  dialog.addEventListener('close', () => write('about', false));

  if (readBoolean('about', false)) dialog.showModal();

  return {
    setOpen(on: boolean): void {
      if (on === dialog.open) return;
      if (on) dialog.showModal();
      else dialog.close();
    },
  };
}
