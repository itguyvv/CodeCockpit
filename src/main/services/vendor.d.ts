// Ambient types for the two untyped pure-JS network dependencies used by publicAccess.
// Only the surface actually used is declared; upstream ships no .d.ts.

declare module '@silentbot1/nat-api' {
  interface NatApiMapping {
    publicPort: number
    privatePort: number
    ttl?: number
    protocol?: 'TCP' | 'UDP'
  }

  interface NatApiOptions {
    /** Mapping lease in seconds; autoUpdate renews it while the client lives */
    ttl?: number
    autoUpdate?: boolean
    gateway?: string
    enablePMP?: boolean
    enableUPNP?: boolean
    /** Fall back to permanent leases on routers that do not support timed ones */
    upnpPermanentFallback?: boolean
  }

  export default class NatAPI {
    constructor(opts?: NatApiOptions)
    map(opts: NatApiMapping | number, privatePort?: number): Promise<void>
    unmap(opts: NatApiMapping | number, privatePort?: number): Promise<void>
    externalIp(): Promise<string>
    destroy(): Promise<void>
  }
}

declare module 'stun' {
  export interface StunAddress {
    address: string
    port: number
  }

  export interface StunResponse {
    getXorAddress(): StunAddress
  }

  export function request(url: string, options?: Record<string, unknown>): Promise<StunResponse>
}
