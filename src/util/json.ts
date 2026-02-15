export const extractFirstJSONObject = (input: string): string | null => {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }

  return null;
};

export const parseOneJSON = <T = unknown>(input: string): T => {
  const obj = extractFirstJSONObject(input);
  if (obj === null) {
    throw new Error('No JSON object found in LLM output');
  }
  return JSON.parse(obj) as T;
};
