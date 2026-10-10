// Explicit listening registrations. A participant receives audio only if they
// have registered to listen. One active listening device per account: the most
// recent registration wins.

export type Listening = {
  participantId: string;
  deviceId: string;
  // Hex-encoded ephemeral PTT push token, if the device has one.
  pttToken: string | undefined;
  registeredAtMs: number;
  tokenValid: boolean;
};

export class ListeningRegistry {
  readonly #byParticipant = new Map<string, Listening>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  register(participantId: string, deviceId: string, pttToken?: string): Listening {
    const l: Listening = {
      participantId,
      deviceId,
      pttToken: pttToken || undefined,
      registeredAtMs: this.#now(),
      tokenValid: Boolean(pttToken),
    };
    this.#byParticipant.set(participantId, l);
    return l;
  }

  unregister(participantId: string, deviceId?: string): void {
    const l = this.#byParticipant.get(participantId);
    if (l && (deviceId === undefined || l.deviceId === deviceId)) this.#byParticipant.delete(participantId);
  }

  get(participantId: string): Listening | undefined {
    return this.#byParticipant.get(participantId);
  }

  isListening(participantId: string): boolean {
    return this.#byParticipant.has(participantId);
  }

  // Called when APNs reports a token as unregistered or invalid. The device
  // stays registered for foreground audio but is no longer pushable.
  invalidateToken(participantId: string, pttToken: string): boolean {
    const l = this.#byParticipant.get(participantId);
    if (l && l.pttToken === pttToken) {
      l.tokenValid = false;
      return true;
    }
    return false;
  }
}
