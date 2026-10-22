import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { InboxPage } from '../features/inbox/InboxPage';
import { SummaryPage } from '../features/summary/SummaryPage';
import { SectionPlaceholder } from '../features/navigation/SectionPlaceholder';

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false }
    }
  });
}

const defaultQueryClient = createAppQueryClient();

export default function App({ queryClient = defaultQueryClient }: { queryClient?: QueryClient } = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/inbox">
        <AppShell>
          <Routes>
            <Route path="/" element={<InboxPage />} />
            <Route path="/summary" element={<SummaryPage />} />
            <Route path="/:conversationId" element={<InboxPage />} />
            <Route path="/contacts" element={<SectionPlaceholder title="Contactos" />} />
            <Route path="/channels" element={<SectionPlaceholder title="Canales" />} />
            <Route path="/system" element={<SectionPlaceholder title="Sistema" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
