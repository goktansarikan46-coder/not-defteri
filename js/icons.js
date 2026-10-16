const paths = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  folderPlus: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  pen: '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z"/><path d="M14.5 5.5l3 3"/>',
  highlighter: '<path d="M9 11.5l-5.5 5.5V20h4.5l4.5-4.5"/><path d="M14.5 3.5l6 6-7.5 7.5-6-6z"/>',
  eraser: '<path d="M8 20h12"/><path d="M4.6 14.6l8.8-8.8a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8L11.4 19.4a2 2 0 0 1-1.4.6H8.8a2 2 0 0 1-1.4-.6l-2.8-2.8a2 2 0 0 1 0-2z"/><path d="M8.5 10.7l4.8 4.8"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5M8 11h6"/>',
  hand: '<path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11M15 10.5V5a1.5 1.5 0 0 0-3 0v5.5M12 10.5V6a1.5 1.5 0 0 0-3 0v8"/><path d="M18 8.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a7 7 0 0 1-5.2-2.3L3.6 15.8a1.6 1.6 0 0 1 2.3-2.2L9 16"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/>',
  more: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pages: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
