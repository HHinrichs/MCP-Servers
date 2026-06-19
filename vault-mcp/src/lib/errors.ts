// Typed errors thrown by mutation transforms. None of these are RefMovedError,
// so the CAS write loop aborts immediately (no retry, no write) and the tool
// handler maps them to a fail-loud {isError:true} response.

export class SectionNotFoundError extends Error {
  constructor(public readonly section: string) {
    super(`section '## ${section}' not found`);
    this.name = "SectionNotFoundError";
  }
}

export class SectionConflictError extends Error {
  constructor(
    public readonly section: string,
    public readonly actual: string,
  ) {
    super(`section '## ${section}' changed since it was read`);
    this.name = "SectionConflictError";
  }
}

export class NoteExistsError extends Error {
  constructor(public readonly path: string) {
    super(`note already exists: ${path}`);
    this.name = "NoteExistsError";
  }
}
