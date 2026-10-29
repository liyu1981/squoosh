interface MultiPanelAttributes extends preact.JSX.AllHTMLAttributes {
  'open-one-only'?: boolean;
}

declare module 'preact' {
  namespace createElement.JSX {
    interface IntrinsicElements {
      'multi-panel': MultiPanelAttributes;
    }
  }
}

export {};
