export interface TextEdit {
  file: string;
  search: string;
  replace: string;
  all?: boolean;
}

export interface ApplyTextEditsResult {
  content: string;
  changed: boolean;
}

export const applyTextEdits = (
  content: string,
  edits: TextEdit[],
): ApplyTextEditsResult => {
  let next = content;
  let changed = false;
  for (const edit of edits) {
    if (edit.search === '') {
      continue;
    }
    if (edit.all) {
      if (!next.includes(edit.search)) {
        continue;
      }
      next = next.split(edit.search).join(edit.replace);
      changed = true;
      continue;
    }
    if (!next.includes(edit.search)) {
      continue;
    }
    next = next.replace(edit.search, edit.replace);
    changed = true;
  }
  return { content: next, changed };
};
