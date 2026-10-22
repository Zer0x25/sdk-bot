import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { InboxPage } from '../features/inbox/InboxPage';
import { SummaryPage } from '../features/summary/SummaryPage';
import { ContactsPage } from '../features/contacts/ContactsPage';
import { ChannelsPage } from '../features/channels/ChannelsPage';
import { AssistantPage } from '../features/assistant/AssistantPage';
import { SystemPage } from '../features/system/SystemPage';

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
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
