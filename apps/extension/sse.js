/**
 * Server-sent events read off a `fetch` response.
 *
 * EventSource cannot POST, and the message rides in the request body, so the
 * stream has to be parsed by hand. The web UI carries its own copy of this:
 * there is no bundler in this project, and an extension can only load files
 * that ship inside it.
 *
 * Handlers are awaited. The server stops sending until a wallet request is
 * answered, and awaiting also keeps the stream from ending before the last
 * frame has been painted.
 */
export async function readSse(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data && handlers[event]) await handlers[event](JSON.parse(data));
    }
  }
}
