import { Component, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { err: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: any) {
    console.error('[V2 page crash]', err, info);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="content content-wide">
        <div className="card">
          <div className="card-title">Page crashed</div>
          <div className="lw-placeholder">
            <div className="lw-placeholder-glyph">⚠</div>
            <div className="lw-placeholder-title">{this.state.err.name}</div>
            <div className="lw-placeholder-sub" style={{ fontFamily: 'Sora, monospace', fontSize: 11 }}>
              {this.state.err.message}
            </div>
            <button className="btn-mini btn-stake" style={{ marginTop: 16, maxWidth: 200 }} onClick={this.reset}>
              Reset
            </button>
          </div>
        </div>
      </div>
    );
  }
}
