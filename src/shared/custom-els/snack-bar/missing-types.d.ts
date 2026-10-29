import type { SnackOptions } from '.';
import type preact from 'preact';

interface SnackBarAttributes extends preact.JSX.AllHTMLAttributes {
  showSnackbar?: (options: SnackOptions) => Promise<string>;
}

declare module 'preact' {
  namespace createElement.JSX {
    interface IntrinsicElements {
      'snack-bar': SnackBarAttributes;
    }
  }
}

export {};
