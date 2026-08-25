import { AbstractInputSuggest, App, TFolder } from 'obsidian';

/**
 * Folder selector bound to a text input. Shows a dropdown of every vault
 * folder matching the typed query; selecting one fills the input. Works on
 * desktop and mobile (Obsidian's native Suggest panel).
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const folders: TFolder[] = [];
    const lower = (query || '').toLowerCase();
    const visit = (f: TFolder) => {
      folders.push(f);
      f.children.forEach((c) => {
        if (c instanceof TFolder) visit(c);
      });
    };
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if (f instanceof TFolder) visit(f);
    });
    return folders
      .filter((f) => f.path.toLowerCase().includes(lower))
      .slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path || '/');
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path || '/';
    this.inputEl.trigger('input');
    this.close();
  }
}
