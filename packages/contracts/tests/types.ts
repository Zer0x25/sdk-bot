import { assertValid, validate, type Contract, type operations } from '..';

const control: Contract<'TakeoverRequest'> = { expectedVersion: '1' };
const release: Contract<'ReleaseRequest'> = { expectedVersion: '2' };
const releasePending: Contract<'ReleaseRequest'> = {
  expectedVersion: '2', resumePolicy: 'process_pending', pendingInboundIds: ['id'],
  selectionVersion: '0'.repeat(64),
};
const query: Contract<'MessagesQuery'> = {};
const queryThroughApi: NonNullable<operations['listMessages']['parameters']['query']> = {};
const send: Contract<'SendMessageRequest'> = {
  expectedVersion: '1', clientMessageId: 'id', text: 'hola',
};
const requestThroughApi: operations['takeControl']['requestBody']['content']['application/json'] = control;
const assistance: Contract<'ConversationAssistanceRequest'> = {
  expectedContextVersion: '2', expectedSnapshot: { dataEpoch: '11111111-1111-4111-8111-111111111111', seq: '4' }
};
const toolRequest: Contract<'AssistantToolRequest'> = {
  kind: 'tool_request', toolName: 'conversation.search_messages', effect: 'read', input: { query: 'viernes', limit: 3 }
};
const nullableProvider: Contract<'Message'>['providerMessageId'] = null;
const input: unknown = { expectedVersion: '1' };
const result = validate('TakeoverRequest', input);
if (result.valid) {
  const version: string = result.value.expectedVersion;
  void version;
} else {
  const keyword: string = result.errors[0].keyword;
  void keyword;
}
const id: string = assertValid('TelegramChatId', '-9007199254740993');
// @ts-expect-error IDs always retain sign and precision as text.
const numericId: Contract<'TelegramChatId'> = 9007199254740993;
// @ts-expect-error expectedVersion always references textual controlVersion.
const numericVersion: Contract<'TakeoverRequest'> = { expectedVersion: 1 };
// @ts-expect-error process_pending needs explicit input selection.
const missingSelection: Contract<'ReleaseRequest'> = { expectedVersion: '2', resumePolicy: 'process_pending' };
// @ts-expect-error Client cannot impersonate actor in the mutation body.
const forgedActor: Contract<'SendMessageRequest'> = { ...send, actorId: 'id' };
// @ts-expect-error Contract name is closed and shared with runtime validators.
validate('MissingContract', input);
void [release, releasePending, query, queryThroughApi, requestThroughApi, nullableProvider,
  assistance, toolRequest, id, numericId, numericVersion, missingSelection, forgedActor];
