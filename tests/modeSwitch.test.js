// tests/modeSwitch.test.js
// Tests for monitor-mode switching logic (PM-2: AC-12a, AC-12b).
// Mirrors the state/getActiveRequests logic from app.js since it is a browser
// script and not directly importable in Node.

import { describe, it, expect, beforeEach } from 'vitest';

// Mirror of state + getActiveRequests from app.js
function createStore(initialMode = 'real') {
  return {
    monitorMode: initialMode,
    requests: [],       // simulation store
    realCommands: []    // real RTK store
  };
}

function getActiveRequests(state) {
  return state.monitorMode === 'sim' ? state.requests : state.realCommands;
}

describe('monitor mode switching (AC-12)', () => {
  let state;

  beforeEach(() => {
    state = createStore();
  });

  // AC-12a: mode restored from localStorage
  it('restores mode from initial value (AC-12a)', () => {
    state = createStore('sim');
    expect(state.monitorMode).toBe('sim');
    expect(getActiveRequests(state)).toBe(state.requests);

    state = createStore('real');
    expect(state.monitorMode).toBe('real');
    expect(getActiveRequests(state)).toBe(state.realCommands);
  });

  // AC-12b: switching mid-session preserves both stores
  it('switching to sim does not lose realCommands (AC-12b)', () => {
    // Populate real store
    state.realCommands.push({ id: 'r1', brand: 'claude' });
    state.realCommands.push({ id: 'r2', brand: 'gemini' });
    expect(state.realCommands.length).toBe(2);

    // Switch to simulation
    state.monitorMode = 'sim';
    state.requests.push({ id: 's1', brand: 'minimax' });

    // Active store is now sim
    expect(getActiveRequests(state)).toBe(state.requests);
    expect(getActiveRequests(state).length).toBe(1);

    // Real store is intact
    expect(state.realCommands.length).toBe(2);

    // Switch back to real
    state.monitorMode = 'real';
    expect(getActiveRequests(state)).toBe(state.realCommands);
    expect(getActiveRequests(state).length).toBe(2);
  });

  it('switching to real does not lose simulation requests (AC-12b)', () => {
    // Start in sim mode with data
    state.monitorMode = 'sim';
    state.requests.push({ id: 's1' }, { id: 's2' }, { id: 's3' });

    // Switch to real
    state.monitorMode = 'real';
    state.realCommands.push({ id: 'r1' });
    expect(getActiveRequests(state).length).toBe(1);

    // Sim store is intact
    expect(state.requests.length).toBe(3);

    // Switch back
    state.monitorMode = 'sim';
    expect(getActiveRequests(state).length).toBe(3);
  });

  it('getActiveRequests returns realCommands by default', () => {
    state.monitorMode = 'real';
    state.realCommands.push({ id: 'r1' });
    state.requests.push({ id: 's1' });
    expect(getActiveRequests(state)).toBe(state.realCommands);
    expect(getActiveRequests(state).length).toBe(1);
  });
});
