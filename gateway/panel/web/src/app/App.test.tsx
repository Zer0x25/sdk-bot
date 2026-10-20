import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/inbox/');
});

describe('inbox shell', () => {
  it('renders the accessible three-panel workspace without fabricated conversation data', () => {
    window.history.replaceState({}, '', '/inbox/');
    render(<App />);

    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bandeja' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conversaciones' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Historial del chat' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Información del contacto' })).toBeInTheDocument();
    expect(screen.getByText(/No mostramos datos de ejemplo/)).toBeInTheDocument();
    expect(screen.queryByText('private message body')).not.toBeInTheDocument();
  });

  it('keeps navigation real and marks the active destination', () => {
    window.history.replaceState({}, '', '/inbox/contacts');
    render(<App />);

    expect(screen.getByRole('link', { name: 'Contactos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Contactos' })).toBeInTheDocument();
  });

  it('makes the skip-to-content link reachable by keyboard', async () => {
    window.history.replaceState({}, '', '/inbox/');
    render(<App />);
    await userEvent.tab();

    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveFocus();
  });
});
