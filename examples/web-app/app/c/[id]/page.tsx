import { ChatView } from '@/components/chat-view';

export default async function SavedChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView chatId={id} />;
}
