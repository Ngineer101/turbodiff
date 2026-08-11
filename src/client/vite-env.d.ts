/// <reference types="vite/client" />

// The pre-commit type checker doesn't resolve vite/client's asset module
// declarations, so declare the side-effect CSS import explicitly.
declare module '*.css';
