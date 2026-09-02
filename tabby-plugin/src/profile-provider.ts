import { Inject, Injectable, OnDestroy, Optional } from "@angular/core"
import * as NodeModule from "node:module"
import type { PartialProfile, ProfileProvider as ProfileProviderType, RecoveryToken, TabRecoveryProvider as TabRecoveryProviderType } from "tabby-core"
import type { LocalProfile, SessionOptions } from "tabby-local"
import { TabbyRuntimeManager } from "./runtime.ts"
import { TerminalTab } from "./terminal-tab.ts"

const require = NodeModule.createRequire(__filename)
const { ProfileProvider, TabRecoveryProvider } = require("tabby-core") as {
  ProfileProvider: typeof ProfileProviderType
  TabRecoveryProvider: typeof TabRecoveryProviderType
}

type CompleteSessionOptions = SessionOptions & { shellType: "unix" }

const defaultSessionOptions = (command = ""): CompleteSessionOptions => ({
  restoreFromPTYID: null,
  command,
  args: [],
  cwd: null,
  env: {},
  width: null,
  height: null,
  shellType: "unix",
  pauseAfterExit: false,
  runAsAdministrator: false,
} as unknown as CompleteSessionOptions)

export type LaunchProfile = { name: string; directory: string; correlationId?: string; secret?: string; endpoint?: string }
export type NotifierProfile = LocalProfile
export const NOTIFIER_RECOVERY_TYPE = "opencode-tabby-notifier:recovery"
const MAX_RECOVERY_TOKEN_DEPTH = 64

type RecoveryRecord = {
  type?: string
  profile?: { type?: string }
  children?: RecoveryRecord[]
}

export function sanitizeLaunchProfile(profile: LaunchProfile): { name: string; directory: string } {
  return { name: profile.name, directory: profile.directory }
}

export function createLaunchEnvironment(
  correlationId: string,
  secret: string,
  endpoint?: string,
  projectLabel?: string,
): Record<string, string> {
  return {
    OPENCODE_NOTIFY_CORRELATION: correlationId,
    OPENCODE_NOTIFY_IPC_SECRET: secret,
    ...(endpoint === undefined ? {} : { OPENCODE_NOTIFY_IPC_ENDPOINT: endpoint }),
    ...(projectLabel === undefined ? {} : { OPENCODE_NOTIFY_PROJECT_LABEL: projectLabel }),
  }
}

export function migrateNotifierRecoveryTokens(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }): void {
  try {
    const raw = storage.getItem("tabsRecovery")
    if (!raw) return
    const tokens = JSON.parse(raw) as RecoveryRecord[]
    let changed = false
    for (const token of tokens) {
      const migrate = (record: RecoveryRecord, depth: number): void => {
        if (record.type === "app:local-tab" && record.profile?.type === "opencode-tabby-notifier") {
          record.type = NOTIFIER_RECOVERY_TYPE
          changed = true
          return
        }
        if (record.type !== "app:split-tab" || depth >= MAX_RECOVERY_TOKEN_DEPTH || !Array.isArray(record.children)) return
        for (const child of record.children) {
          if (child && typeof child === "object") migrate(child, depth + 1)
        }
      }
      if (token && typeof token === "object") migrate(token, 0)
    }
    if (changed) storage.setItem("tabsRecovery", JSON.stringify(tokens))
  } catch {
    // A malformed recovery record must not prevent Tabby from starting.
  }
}

export function cloneRuntimeProfile(profile: NotifierProfile): NotifierProfile {
  const options = profile.options ?? defaultSessionOptions()
  return {
    ...profile,
    options: {
      ...defaultSessionOptions(),
      ...options,
      args: [...(options.args ?? [])],
      env: { ...(options.env ?? {}) },
    },
  }
}

async function createRuntimeProfile(
  profile: NotifierProfile,
  runtimeManager: TabbyRuntimeManager,
  restoreFromPTYID: string | null = profile.options.restoreFromPTYID ?? null,
): Promise<{ profile: NotifierProfile; correlationId: string }> {
  const runtimeProfile = cloneRuntimeProfile(profile)
  const runtime = await runtimeManager.createRuntime()
  ;(runtimeProfile.options as unknown as { restoreFromPTYID: string | null }).restoreFromPTYID = restoreFromPTYID
  runtimeProfile.options.env = {
    ...runtimeProfile.options.env,
    ...createLaunchEnvironment(runtime.correlationId, runtime.secret, runtime.endpoint, profile.name),
  }
  return { profile: runtimeProfile, correlationId: runtime.correlationId }
}

@Injectable()
export class TabbyCompletionProfileProvider extends ProfileProvider<NotifierProfile> implements OnDestroy {
  readonly id = "opencode-tabby-notifier"
  readonly name = "OpenCode Tabby notifier"
  readonly configDefaults = { options: defaultSessionOptions() }
  private readonly runtimeManager: TabbyRuntimeManager

  constructor(runtimeManager: TabbyRuntimeManager | null = null) {
    super()
    this.runtimeManager = runtimeManager ?? new TabbyRuntimeManager(TerminalTab.sharedRegistry)
  }

  async getBuiltinProfiles(): Promise<PartialProfile<NotifierProfile>[]> {
    return [{
      id: `${this.id}:shell`,
      type: this.id,
      name: "OpenCode notifier shell",
      icon: "fas fa-terminal",
      options: defaultSessionOptions(process.env.SHELL || "/bin/bash"),
      isBuiltin: true,
    }]
  }

  async getNewTabParameters(profile: NotifierProfile): Promise<{
    type: typeof TerminalTab
    inputs: { profile: NotifierProfile; correlationId: string }
  }> {
    const runtime = await createRuntimeProfile(profile, this.runtimeManager)
    return {
      type: TerminalTab,
      inputs: {
        profile: runtime.profile,
        correlationId: runtime.correlationId,
      },
    }
  }

  getDescription(profile: PartialProfile<NotifierProfile>): string {
    return profile.options?.command || "Local notifier shell (runtime credentials are never saved)."
  }

  shutdown(): Promise<void> {
    return this.runtimeManager.shutdown()
  }

  ngOnDestroy(): void {
    void this.shutdown()
  }
}

@Injectable()
export class TabbyCompletionRecoveryProvider extends TabRecoveryProvider<TerminalTab> {
  readonly recoveryType = NOTIFIER_RECOVERY_TYPE

  constructor(private readonly runtimeManager: TabbyRuntimeManager | null = null) {
    super()
  }

  async applicableTo(recoveryToken: RecoveryToken): Promise<boolean> {
    return recoveryToken.type === this.recoveryType
  }

  async recover(recoveryToken: RecoveryToken): Promise<{
    type: typeof TerminalTab
    inputs: { profile: NotifierProfile; correlationId: string }
  }> {
    const profile = recoveryToken.profile as NotifierProfile | undefined
    if (!profile?.options) throw new Error("Invalid OpenCode notifier recovery token")
    const runtime = await createRuntimeProfile(
      profile,
      this.runtimeManager ?? new TabbyRuntimeManager(TerminalTab.sharedRegistry),
      null,
    )
    return { type: TerminalTab, inputs: runtime }
  }
}

// Equivalent to @Optional() @Inject(TabbyRuntimeManager), kept as runtime metadata
// so the source-only test setup does not need legacy parameter-decorator transforms.
Inject(TabbyRuntimeManager)(TabbyCompletionRecoveryProvider, undefined, 0)
Optional()(TabbyCompletionRecoveryProvider, undefined, 0)
Inject(TabbyRuntimeManager)(TabbyCompletionProfileProvider, undefined, 0)
Optional()(TabbyCompletionProfileProvider, undefined, 0)
Inject(TabbyRuntimeManager)(TabbyCompletionRecoveryProvider, undefined, 0)
Optional()(TabbyCompletionRecoveryProvider, undefined, 0)
