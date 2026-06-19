import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ error, info });
    console.error("ErrorBoundary caught an error", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: '#fee2e2', color: '#991b1b', borderRadius: '8px', margin: '20px', fontFamily: 'monospace' }}>
          <h2>UI Crashed</h2>
          <p>{this.state.error?.toString()}</p>
          <p>Please copy this error and share it with the AI agent.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
