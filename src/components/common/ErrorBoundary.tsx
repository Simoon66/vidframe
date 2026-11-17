import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error.message || 'An unexpected UI error occurred.';
    try {
      const parsed = JSON.parse(readable);
      if (parsed?.error) readable = parsed.error;
    } catch {}
    return { hasError: true, errorMessage: readable };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[VidFrame ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0a0a0c] text-zinc-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-zinc-950 border border-red-900/50 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="text-red-500 text-xs font-semibold uppercase tracking-wider">Application Recovery</div>
            <h2 className="text-lg font-bold text-white">Something went wrong rendering this view</h2>
            <p className="text-xs text-zinc-400 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3 font-mono break-words">
              {this.state.errorMessage}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, errorMessage: '' });
                window.location.reload();
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-xl cursor-pointer transition"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
