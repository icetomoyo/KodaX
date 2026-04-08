import React, { PureComponent } from 'react';
import ErrorOverview from './ErrorOverview.js';

export default class ErrorBoundary extends PureComponent {
    static displayName = 'InternalErrorBoundary';
    static getDerivedStateFromError(error) {
        return { error };
    }
    state = {
        error: undefined,
    };
    componentDidCatch(error) {
        this.props.onError(error);
    }
    render() {
        if (this.state.error) {
            return React.createElement(ErrorOverview, { error: this.state.error });
        }
        return this.props.children;
    }
}
