// Generated from openapi.json + schema.json. Run npm run contracts:generate.
export interface paths {
    "/accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAccounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/attachments/{attachmentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Descarga de bytes solo tras verificar conversations:read y acceso a la conversación asociada. Los archivos caducan 90 días después de la captura durable. */
        get: operations["downloadAttachment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listConversations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateConversation"];
        trace?: never;
    };
    "/conversations/{conversationId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listMessages"];
        put?: never;
        post: operations["sendMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversationId}/pending-resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listPendingResumeMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversationId}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["markRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversationId}/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["releaseControl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversationId}/takeover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["takeControl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description SSE autenticado y durable. Sin Last-Event-ID emite un checkpoint id-only del watermark actual; el cliente carga un snapshot después de abrir el stream. Cada reconexión con Last-Event-ID reproduce eventos retenidos después del cursor. Si cambia epoch o hay un hueco por retención, emite resync.required en el watermark actual. Los eventos se publican tras commit, cada data es JSON Event validado y no contiene cuerpos. El stream termina al expirar el grant firmado para volver a validar permisos. */
        get: operations["subscribeEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAutomationProfiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Métricas de entradas y salidas archivadas en el intervalo UTC [from,to); solo se cuentan salidas aceptadas. */
        get: operations["getSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @enum {string} */
        AccessPolicy: "allowed" | "ignored" | "neutral";
        Account: {
            capabilities: components["schemas"]["ChannelCapabilities"];
            channel: components["schemas"]["Channel"];
            /** Format: unicode-text */
            displayName: string;
            id: components["schemas"]["Id"];
            status: components["schemas"]["AccountStatus"];
        };
        AccountsResponse: {
            items: components["schemas"]["Account"][];
        };
        /** @enum {string} */
        AccountStatus: "connected" | "disconnected" | "connecting" | "requires_auth" | "error";
        Actor: {
            capabilities: components["schemas"]["Capability"][];
            /** Format: unicode-text */
            displayName: string;
            id: components["schemas"]["Id"];
        };
        /** @enum {string} */
        AutomationMode: "ai" | "human" | "off";
        AutomationProfile: {
            key: string;
            /** Format: unicode-text */
            name: string;
        };
        AutomationProfilesResponse: {
            items: components["schemas"]["AutomationProfile"][];
        };
        /** @enum {string} */
        Capability: "conversations:read" | "messages:send" | "control:write" | "control:override" | "conversations:write" | "admin:write";
        /** @enum {string} */
        Channel: "whatsapp" | "telegram";
        ChannelCapabilities: {
            attachments: boolean;
            deliveryReceipt: boolean;
            edit: boolean;
            historySync: boolean;
            readReceipt: boolean;
            reply: boolean;
        };
        Contact: {
            displayName: string | null;
            id: components["schemas"]["Id"];
            identities: components["schemas"]["Identity"][];
        };
        Conversation: {
            accountId: components["schemas"]["Id"];
            aggregateVersion: components["schemas"]["Version"];
            canonicalIdentityId: components["schemas"]["Id"];
            contactId: components["schemas"]["Id"];
            control: components["schemas"]["ConversationControl"];
            displayName?: string | null;
            historyCoverage: components["schemas"]["HistoryCoverage"];
            id: components["schemas"]["Id"];
            lastActivityAt: components["schemas"]["Timestamp"] | null;
            requiresReview: boolean;
            unreadCount: number;
        };
        /** @description Forma de proyección; elegibilidad/cancelación/barrera se verifican en servicio de dominio F5. */
        ConversationControl: {
            accessPolicy: components["schemas"]["AccessPolicy"];
            automationMode: components["schemas"]["AutomationMode"];
            contextVersion: components["schemas"]["Version"];
            controlVersion: components["schemas"]["Version"];
            handoffReason: ("operator" | "customer_request" | "external_self" | "legacy_import" | "identity_conflict") | null;
            lifecycle: components["schemas"]["Lifecycle"];
            ownerId: components["schemas"]["Id"] | null;
            profileKey: string | null;
            requiresReview: boolean;
            reviewReasons: ("invalid_legacy_state" | "invalid_profile_key" | "profile_inventory_unavailable" | "profile_missing")[];
            /** @enum {string} */
            status: "confirmed" | "taking_control";
            takenAt: components["schemas"]["Timestamp"] | null;
        };
        ConversationResponse: {
            channelCapabilities: components["schemas"]["ChannelCapabilities"];
            conversation: components["schemas"]["Conversation"];
            snapshot: components["schemas"]["EventCursor"];
        };
        ConversationsQuery: {
            accountId?: components["schemas"]["Id"];
            automationMode?: components["schemas"]["AutomationMode"];
            channel?: components["schemas"]["Channel"];
            cursor?: components["schemas"]["PageCursor"];
            lifecycle?: components["schemas"]["Lifecycle"];
            limit?: components["schemas"]["PageLimit"];
            /** Format: unicode-text */
            search?: string;
            unreadOnly?: boolean;
        };
        ConversationsResponse: {
            items: components["schemas"]["Conversation"][];
            nextCursor: components["schemas"]["PageCursor"] | null;
            snapshot: components["schemas"]["EventCursor"];
        };
        /** @description Solo con providerMessageId conocido; rawChatId es procedencia, no clave. La unión verificada reindexa en transacción. */
        DeduplicationKey: {
            accountId: components["schemas"]["Id"];
            canonicalIdentityId: components["schemas"]["Id"];
            providerMessageId: components["schemas"]["ProviderMessageId"];
        };
        /** @enum {string} */
        DeliveryStatus: "received" | "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "delivery_unknown" | "cancelled";
        /** @enum {string} */
        ErrorCode: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION_ERROR" | "VERSION_CONFLICT" | "OWNER_CONFLICT" | "IDENTITY_AMBIGUOUS" | "IDENTITY_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_RESULT_EXPIRED" | "CONTROL_NOT_CONFIRMED" | "CHANNEL_NOT_READY" | "CONVERSATION_NOT_FOUND" | "CONTROL_AUTHORITY_NOT_ACTIVE" | "CONTROL_HUMAN_SEND_IN_FLIGHT" | "CONTROL_OPERATION_MISSING" | "CONTROL_OWNER_CONFLICT" | "CONTROL_SERVICE_NOT_READY" | "CONTROL_TARGET_NOT_FOUND" | "CONTROL_VERSION_CONFLICT" | "ACCESS_IGNORED" | "CURSOR_EXPIRED" | "DATA_EPOCH_MISMATCH" | "IDEMPOTENCY_KEY_REUSED" | "OUTBOUND_DELIVERY_UNKNOWN" | "OUTBOUND_IN_PROGRESS" | "OUTBOUND_REJECTED" | "PENDING_RESUME_MESSAGE_NOT_ELIGIBLE" | "PENDING_RESUME_NOT_AVAILABLE" | "PENDING_RESUME_SELECTION_STALE" | "SERVICE_UNAVAILABLE" | "TIMEOUT" | "INTERNAL_ERROR";
        /** @description Solo mensajes saneados. Sin raw, stack, rutas locales, tokens ni payload arbitrario. */
        ErrorResponse: {
            error: {
                code: components["schemas"]["ErrorCode"];
                details?: {
                    field: string;
                    /** Format: unicode-text */
                    reason: string;
                }[];
                /** Format: unicode-text */
                message: string;
                requestId: components["schemas"]["Id"];
            };
        };
        /** @description Invalidaciones mínimas sin copia de cuerpos/media. Leer recurso autorizado; publicar tras commit; replay durable F3. */
        Event: {
            cursor: components["schemas"]["EventCursor"];
            data: {
                aggregateVersion: components["schemas"]["Version"];
                conversationId: components["schemas"]["Id"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @enum {string} */
            type: "conversation.updated";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                aggregateVersion: components["schemas"]["Version"];
                conversationId: components["schemas"]["Id"];
                messageId: components["schemas"]["Id"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @enum {string} */
            type: "message.created" | "message.updated";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                aggregateVersion: components["schemas"]["Version"];
                conversationId: components["schemas"]["Id"];
                operationId: components["schemas"]["Id"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @enum {string} */
            type: "operation.updated";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                policyVersion: components["schemas"]["Version"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @enum {string} */
            type: "policy.updated";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                /** @enum {string} */
                reason: "epoch_changed" | "cursor_expired" | "scope_changed";
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @enum {string} */
            type: "resync.required";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                aggregateVersion: components["schemas"]["Version"];
                controlVersion: components["schemas"]["Version"];
                conversationId: components["schemas"]["Id"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @constant */
            type: "control.changed";
        } | {
            cursor: components["schemas"]["EventCursor"];
            data: {
                accountId: components["schemas"]["Id"];
                status: components["schemas"]["AccountStatus"];
            };
            occurredAt: components["schemas"]["Timestamp"];
            /** @constant */
            schemaVersion: 1;
            /** @constant */
            type: "channel.updated";
        };
        /** @description Secuencia global no necesariamente consecutiva. Epoch distinto requiere snapshot nuevo. */
        EventCursor: {
            dataEpoch: components["schemas"]["Id"];
            seq: components["schemas"]["Sequence"];
        };
        /** @description SSE id y Last-Event-ID: dataEpoch:seq. */
        EventId: string;
        GlobalPolicy: {
            /** @enum {string} */
            globalMode: "allowed_all" | "ignored_all";
            globalPaused: boolean;
            policyVersion: components["schemas"]["Version"];
        };
        /** @description Nunca certifica historial completo del proveedor. */
        HistoryCoverage: {
            capturingSince: components["schemas"]["Timestamp"] | null;
            /** @enum {string} */
            kind: "capturing_since" | "partial_import" | "provider_sync_observed";
        };
        /**
         * Format: uuid
         * @description UUID interno canónico en minúsculas; nunca ID numérico de proveedor.
         */
        Id: string;
        /** @description Intención única por actor/cuenta/chat; no contiene secretos ni cuerpo. */
        IdempotencyKey: string;
        Identity: {
            canonicalIdentityId: components["schemas"]["Id"];
            contactId: components["schemas"]["Id"];
            id: components["schemas"]["Id"];
            key: components["schemas"]["IdentityKey"];
            /** @enum {string} */
            resolution: "resolved" | "conflict" | "requires_review";
            /** @enum {string} */
            verification: "adapter" | "admin_review";
        };
        /** @description Unicidad exacta (accountId,kind,exactValue). Ningún matcher parcial. */
        IdentityKey: {
            accountId: components["schemas"]["Id"];
            /** @constant */
            channel: "telegram";
            exactValue: components["schemas"]["TelegramChatId"];
            /** @constant */
            kind: "telegram_chat_id";
        } | {
            accountId: components["schemas"]["Id"];
            /** @constant */
            channel: "whatsapp";
            exactValue: string;
            /** @constant */
            kind: "whatsapp_jid";
        } | {
            accountId: components["schemas"]["Id"];
            /** @constant */
            channel: "whatsapp";
            exactValue: string;
            /** @constant */
            kind: "whatsapp_lid";
        } | {
            accountId: components["schemas"]["Id"];
            /** @constant */
            channel: "whatsapp";
            exactValue: string;
            /** @constant */
            kind: "phone";
        };
        /** @enum {string} */
        Lifecycle: "open" | "resolved";
        Message: {
            actorId: components["schemas"]["Id"] | null;
            /** @enum {string} */
            authorKind: "customer" | "ai" | "operator" | "external_self" | "system" | "unknown";
            clientMessageId: components["schemas"]["Id"] | null;
            content: components["schemas"]["MessageContent"];
            conversationId: components["schemas"]["Id"];
            /** @enum {string} */
            deduplicationQuality: "provider_id" | "unknown";
            deliveryStatus: components["schemas"]["DeliveryStatus"];
            /** @enum {string} */
            direction: "inbound" | "outbound";
            id: components["schemas"]["Id"];
            inboundSeq: components["schemas"]["Sequence"] | null;
            ingestedAt: components["schemas"]["Timestamp"];
            occurredAt: components["schemas"]["Timestamp"];
            providerMessageId: components["schemas"]["ProviderMessageId"] | null;
            replyToId: components["schemas"]["Id"] | null;
            /** @enum {string} */
            source: "live" | "history" | "panel" | "automation" | "command" | "import";
        };
        MessageContent: {
            text: components["schemas"]["StoredText"];
            /** @constant */
            type: "text";
        } | ({
            /** @description ID opaco descargable solo mediante la API autenticada de adjuntos. */
            attachmentId?: components["schemas"]["Id"];
            /** @enum {string} */
            availability: "not_stored" | "available" | "expired" | "failed";
            /** @description Texto adjunto literal; opcional para compatibilidad con marcadores anteriores. */
            caption?: components["schemas"]["StoredText"];
            transcript: components["schemas"]["StoredText"] | null;
            /** @enum {string} */
            transcriptionStatus: "not_requested" | "pending" | "completed" | "failed";
            /** @enum {string} */
            type: "audio" | "image" | "video" | "document" | "unsupported";
        } & (unknown & unknown & unknown)) | {
            originalBytes: number;
            /** @constant */
            reason: "text_limit";
            /** @constant */
            type: "oversized";
        };
        MessagesQuery: {
            cursor?: components["schemas"]["PageCursor"];
            limit?: components["schemas"]["PageLimit"];
        };
        /** @description Página en orden cronológico estable (occurredAt,id), retención por ingestedAt. */
        MessagesResponse: {
            items: components["schemas"]["Message"][];
            nextCursor: components["schemas"]["PageCursor"] | null;
            snapshot: components["schemas"]["EventCursor"];
        };
        Operation: {
            actorId: components["schemas"]["Id"];
            completedAt: components["schemas"]["Timestamp"] | null;
            controlVersion: components["schemas"]["Version"];
            conversationId: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            id: components["schemas"]["Id"];
            /** @enum {string} */
            status: "taking_control" | "completed" | "failed";
            /** @constant */
            type: "takeover";
            uncertainMessageIds: components["schemas"]["Id"][];
        };
        /**
         * Format: unicode-text
         * @description Texto literal; puntos de código Unicode, no unidades UTF16. No comandos/Markdown implícitos.
         */
        OutgoingText: string;
        /** @description Opaco, ligado a epoch/ámbito/filtros/orden. Su contenido se valida en servidor. */
        PageCursor: string;
        /** @default 50 */
        PageLimit: number;
        PendingResumeCandidate: {
            /** @enum {string} */
            contentType: "text" | "audio" | "image" | "video" | "document";
            inboundSeq: components["schemas"]["Sequence"];
            ingestedAt: components["schemas"]["Timestamp"];
            messageId: components["schemas"]["Id"];
            occurredAt: components["schemas"]["Timestamp"];
            preview: string;
        };
        PendingResumeResponse: {
            automationMayBeBlocked: boolean;
            candidateCount: number;
            candidates: components["schemas"]["PendingResumeCandidate"][];
            controlVersion: components["schemas"]["Version"];
            conversationId: components["schemas"]["Id"];
            excludedPendingDispatchCount: number;
            excludedUnprocessableCount: number;
            selectionVersion: string;
            truncated: boolean;
            uncertainOutboundCount: number;
        };
        ProviderMessageId: string;
        /** @description Cursor monotónico del actor y chat; no recibo del proveedor. */
        ReadRequest: {
            throughInboundSeq: components["schemas"]["Sequence"];
        };
        ReadResponse: {
            throughInboundSeq: components["schemas"]["Sequence"];
        };
        /** @description Selección pendiente explícita; servicio comprueba live/no atendida/24h/versión. No reanima jobs antiguos. */
        ReleaseRequest: {
            expectedVersion: components["schemas"]["Version"];
            /** @default false */
            overrideOwner?: boolean;
            /**
             * @default future_only
             * @constant
             */
            resumePolicy?: "future_only";
        } | {
            expectedVersion: components["schemas"]["Version"];
            /** @default false */
            overrideOwner?: boolean;
            pendingInboundIds: components["schemas"]["Id"][];
            /** @constant */
            resumePolicy: "process_pending";
            selectionVersion: string;
        };
        /** Format: unicode-text */
        search: string;
        SendMessageRequest: {
            clientMessageId: components["schemas"]["Id"];
            expectedVersion: components["schemas"]["Version"];
            handledThroughInboundSeq?: components["schemas"]["Sequence"];
            text: components["schemas"]["OutgoingText"];
        };
        /** @description HTTP202 confirma intención durable, no entrega en proveedor. */
        SendMessageResponse: {
            clientMessageId: components["schemas"]["Id"];
            messageId: components["schemas"]["Id"];
        };
        /** @description Decimal canónico como texto; sin Number. Secuencia 0 es watermark inicial. */
        Sequence: string;
        SessionResponse: {
            actor: components["schemas"]["Actor"];
            policy: components["schemas"]["GlobalPolicy"];
            snapshot: components["schemas"]["EventCursor"];
        };
        /** Format: unicode-text */
        StoredText: string;
        SummaryChannelMetrics: {
            acceptedAiReplies: number;
            acceptedHumanReplies: number;
            /** @description Conversaciones con al menos una entrada durante el intervalo. */
            activeConversations: number;
            channel: components["schemas"]["Channel"];
            inboundMessages: number;
        };
        SummaryQuery: {
            from: components["schemas"]["Timestamp"];
            to: components["schemas"]["Timestamp"];
        };
        SummaryResponse: {
            byChannel: components["schemas"]["SummaryChannelMetrics"][];
            coverageStartAt: components["schemas"]["Timestamp"] | null;
            metrics: {
                acceptedAiReplies: number;
                acceptedHumanReplies: number;
                /** @description Conversaciones con al menos una entrada durante el intervalo. */
                activeConversations: number;
                inboundMessages: number;
            };
            period: {
                from: components["schemas"]["Timestamp"];
                /** @constant */
                interval: "[from,to)";
                to: components["schemas"]["Timestamp"];
            };
            snapshot: components["schemas"]["EventCursor"];
        };
        TakeoverConfirmedResponse: {
            conversation: components["schemas"]["Conversation"];
        };
        /** @description HTTP202; compositor espera operación completada y proyección confirmada. */
        TakeoverPendingResponse: {
            operation: components["schemas"]["Operation"];
        };
        /** @description expectedVersion es controlVersion. Actor exclusivamente de contexto autenticado. */
        TakeoverRequest: {
            expectedVersion: components["schemas"]["Version"];
            /** @default false */
            overrideOwner?: boolean;
        };
        /** @description ID exacto con signo y precisión arbitraria; validar tipo private en adapter, no por signo. */
        TelegramChatId: string;
        /**
         * Format: date-time
         * @description RFC3339 UTC con Z.
         */
        Timestamp: string;
        unreadOnly: boolean;
        /** @description CAS por controlVersion; se requiere al menos un cambio de ciclo, acceso o perfil. null en profileKey hereda el perfil global. */
        UpdateConversationRequest: {
            accessPolicy?: components["schemas"]["AccessPolicy"];
            expectedVersion: components["schemas"]["Version"];
            lifecycle?: components["schemas"]["Lifecycle"];
            profileKey?: string | null;
        } | {
            lifecycle: components["schemas"]["Lifecycle"];
        } | {
            accessPolicy: components["schemas"]["AccessPolicy"];
        } | {
            profileKey: string | null;
        };
        /** @description Versión positiva decimal como texto. No intercambiar controlVersion con aggregateVersion. */
        Version: string;
    };
    responses: {
        /** @description Sin sesión válida. */
        401: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Capacidad denegada. */
        403: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Recurso desconocido. */
        404: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Conflicto versión/propietario/identidad/idempotencia. */
        409: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Cursor o resultado de idempotencia expirado; nunca ejecutar intención otra vez. */
        410: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Formato inválido. */
        422: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Servicio temporalmente no disponible. */
        503: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: {
        IdempotencyKey: components["schemas"]["IdempotencyKey"];
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listAccounts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cuentas sin credenciales. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountsResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    downloadAttachment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attachmentId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Archivo opaco; no se sirve como contenido ejecutable del origen. */
            200: {
                headers: {
                    "Content-Disposition"?: string;
                    "Content-Length"?: number;
                    "X-Content-Type-Options"?: "nosniff";
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    listConversations: {
        parameters: {
            query?: {
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                accountId?: components["schemas"]["Id"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                automationMode?: components["schemas"]["AutomationMode"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                channel?: components["schemas"]["Channel"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                cursor?: components["schemas"]["PageCursor"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                lifecycle?: components["schemas"]["Lifecycle"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                limit?: components["schemas"]["PageLimit"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                search?: components["schemas"]["search"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                unreadOnly?: components["schemas"]["unreadOnly"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Página de conversaciones y watermark. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationsResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Proyección y watermark. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    updateConversation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateConversationRequest"];
            };
        };
        responses: {
            /** @description Ciclo actualizado con versión de control. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TakeoverConfirmedResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    listMessages: {
        parameters: {
            query?: {
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                cursor?: components["schemas"]["PageCursor"];
                /** @description Decodificar explícitamente parámetros; sin coerción de IDs. */
                limit?: components["schemas"]["PageLimit"];
            };
            header?: never;
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Página cronológica estable. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MessagesResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    sendMessage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendMessageRequest"];
            };
        };
        responses: {
            /** @description Intención durable; no implica entrega. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SendMessageResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    listPendingResumeMessages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Entradas live no atendidas, recientes y verificables que pueden elegirse al devolver el control. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingResumeResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    markRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReadRequest"];
            };
        };
        responses: {
            /** @description Cursor monotónico local del actor. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    releaseControl: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseRequest"];
            };
        };
        responses: {
            /** @description Liberado conservando permisos/perfil. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TakeoverConfirmedResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    takeControl: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conversationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TakeoverRequest"];
            };
        };
        responses: {
            /** @description Human confirmado. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TakeoverConfirmedResponse"];
                };
            };
            /** @description Despacho previo en red; consultar operación. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TakeoverPendingResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    subscribeEvents: {
        parameters: {
            query?: never;
            header?: {
                "Last-Event-ID"?: components["schemas"]["EventId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stream SSE. Puede incluir líneas id-only de checkpoint sin data; cada frame con data contiene un Event válido. No es un JSON array ni contiene cuerpos. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    getOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resultado de toma de control. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    listAutomationProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Claves y nombres disponibles; no expone contenido de los perfiles. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AutomationProfilesResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            503: components["responses"]["503"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sesión y capacidades verificadas por panel; no aceptar actor del cliente. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            410: components["responses"]["410"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
    getSummary: {
        parameters: {
            query: {
                from: components["schemas"]["Timestamp"];
                to: components["schemas"]["Timestamp"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conteos verificables del archivo y fecha mínima de una entrada archivada. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SummaryResponse"];
                };
            };
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            422: components["responses"]["422"];
            503: components["responses"]["503"];
        };
    };
}
