import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid place-items-center py-24 text-center">
          <div className="max-w-md">
            <p className="text-lg font-semibold text-rose-300">This view hit an error</p>
            <p className="mt-1 text-sm text-slate-500">{String(this.state.error.message)}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded-lg bg-white/5 px-3.5 py-1.5 text-sm text-slate-200 ring-1 ring-inset ring-white/10 hover:bg-white/10"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
