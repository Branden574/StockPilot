/**
 * How many ISBNs the AI Assistant previews or imports in one call (docket
 * B76): BooksImportService.preview refuses more, and execute() runs preview()
 * first. The assistant's tool description and system prompt state it, and the
 * web chat panel checks an attached file's list against it before anything is
 * sent. Bulk ISBN import has its own, larger limit.
 *
 * A plain module (no 'server-only'): the chat panel is a client component.
 */
export const ASSISTANT_ISBN_LIMIT = 50;
