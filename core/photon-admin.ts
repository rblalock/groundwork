import { z } from "zod";

const DEFAULT_BASE_URL = "https://spectrum.photon.codes";
const FAKE_LINE = "+15555550100";

export type PhotonUser = { id: string; e164: string; assignedLine: string };
export interface PhotonAdmin {
  ensureSharedUser(input: { e164: string; firstName?: string; email?: string }): Promise<PhotonUser>;
  /** Removes the number's registration, freeing it. False when it had none. */
  removeSharedUser(e164: string): Promise<boolean>;
}
export type PhotonAdminOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  projectId?: string;
  projectSecret?: string;
};

export class PhotonAdminError extends Error {
  constructor(
    public status: number,
    message?: string,
  ) {
    super(message ?? `Photon management API returned HTTP ${status}.`);
    this.name = "PhotonAdminError";
  }
}

const userSchema = z
  .object({ id: z.string().min(1), phoneNumber: z.string(), assignedPhoneNumber: z.string() })
  .passthrough();
type ProviderUser = z.infer<typeof userSchema>;

const toUser = (row: ProviderUser): PhotonUser => ({
  id: row.id,
  e164: row.phoneNumber,
  assignedLine: row.assignedPhoneNumber,
});

/**
 * Photon's management API, as Groundwork uses it: Basic auth `projectId:projectSecret` and an
 * envelope of `{ succeed: true, data }`. `PHOTON_ADMIN_FAKE=1` skips the network (tests, evals).
 */
export function createPhotonAdmin(options: PhotonAdminOptions = {}): PhotonAdmin {
  const send = async (path: string, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}): Promise<Response> => {
    const projectId = options.projectId ?? process.env.IMESSAGE_PROJECT_ID;
    const projectSecret = options.projectSecret ?? process.env.IMESSAGE_PROJECT_SECRET;
    if (!projectId || !projectSecret) {
      throw new PhotonAdminError(503, "Photon project credentials are not set (IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET).");
    }
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${base}/projects/${encodeURIComponent(projectId)}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PhotonAdminError(503, "Could not reach the Photon management API.");
    }
    return response;
  };

  const request = async <T>(path: string, schema: z.ZodType<T>, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> => {
    const response = await send(path, init);
    if (!response.ok) throw new PhotonAdminError(response.status);
    const envelope = z
      .object({ succeed: z.literal(true), data: schema })
      .safeParse(await response.json().catch(() => undefined));
    if (!envelope.success) throw new PhotonAdminError(502, "Unexpected response from the Photon management API.");
    return envelope.data.data;
  };

  const find = async (e164: string): Promise<ProviderUser | undefined> => {
    const result = await request(
      `/users/?type=shared&search=${encodeURIComponent(e164)}&limit=50`,
      z.object({ users: z.array(userSchema) }).passthrough(),
    );
    return result.users.find((row) => row.phoneNumber === e164);
  };

  return {
    async ensureSharedUser(input) {
      if (process.env.PHOTON_ADMIN_FAKE === "1") {
        return { id: `fake_${input.e164}`, e164: input.e164, assignedLine: FAKE_LINE };
      }
      const existing = await find(input.e164);
      if (existing) return toUser(existing);
      try {
        const created = await request("/users/", userSchema, {
          method: "POST",
          body: {
            type: "shared",
            phoneNumber: input.e164,
            ...(input.firstName ? { firstName: input.firstName } : {}),
            ...(input.email ? { email: input.email } : {}),
          },
        });
        return toUser(created);
      } catch (error) {
        // A concurrent create may already exist; the provider's record is authoritative.
        if (error instanceof PhotonAdminError && error.status === 409) {
          const retried = await find(input.e164);
          if (retried) return toUser(retried);
        }
        throw error;
      }
    },
    async removeSharedUser(e164) {
      if (process.env.PHOTON_ADMIN_FAKE === "1") return true;
      const existing = await find(e164);
      if (!existing) return false;
      const response = await send(`/users/${encodeURIComponent(existing.id)}/`, { method: "DELETE" });
      if (response.status === 404) return false;
      if (!response.ok) throw new PhotonAdminError(response.status);
      return true;
    },
  };
}
