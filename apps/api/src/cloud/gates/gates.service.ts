import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { ConfigEdit } from '../../project/project.types';
import {
  AddGateCommand,
  type AddGateResult,
  CreatePullAddressCommand,
  EditConfigCommand,
  GetConfigQuery,
  type GetConfigResult,
  ListGatesQuery,
  type ListGatesResult,
  ListSecretsQuery,
  type ListSecretsResult,
  PreviewReleaseQuery,
  type PreviewReleaseResult,
  PullBundleQuery,
  type PullAddressResult,
  PutSecretCommand,
  type PutSecretResult,
  ReleaseCommand,
  type ReleaseResult,
  type SaveConfigResult,
  type SealedInput,
  SetConfigCommand,
  UploadBundleCommand,
  type UploadBundleResult,
} from './application/gates.commands';

/** The façade of the controllers (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class GatesService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  getConfig(a: string, o: string, p: string): Promise<GetConfigResult> {
    return this.queries.execute(new GetConfigQuery(a, o, p));
  }
  setConfig(
    a: string,
    o: string,
    p: string,
    text: string,
    base: string | null,
  ): Promise<SaveConfigResult> {
    return this.commands.execute(new SetConfigCommand(a, o, p, text, base));
  }
  editConfig(
    a: string,
    o: string,
    p: string,
    base: string,
    edit: ConfigEdit,
  ): Promise<SaveConfigResult> {
    return this.commands.execute(new EditConfigCommand(a, o, p, base, edit));
  }
  listGates(a: string, o: string, p: string): Promise<ListGatesResult> {
    return this.queries.execute(new ListGatesQuery(a, o, p));
  }
  addGate(
    a: string,
    o: string,
    p: string,
    gate: {
      name: string;
      gateId: string;
      boxKey: string;
      fingerprint: string;
      signerKey: string | null;
    },
  ): Promise<AddGateResult> {
    return this.commands.execute(
      new AddGateCommand(
        a,
        o,
        p,
        gate.name,
        gate.gateId,
        gate.boxKey,
        gate.fingerprint,
        gate.signerKey,
      ),
    );
  }
  createPullAddress(
    a: string,
    o: string,
    p: string,
    gate: string,
  ): Promise<PullAddressResult> {
    return this.commands.execute(new CreatePullAddressCommand(a, o, p, gate));
  }
  listSecrets(
    a: string,
    o: string,
    p: string,
    gate: string,
  ): Promise<ListSecretsResult> {
    return this.queries.execute(new ListSecretsQuery(a, o, p, gate));
  }
  putSecret(
    a: string,
    o: string,
    p: string,
    gate: string,
    name: string,
    sealed: SealedInput,
  ): Promise<PutSecretResult> {
    return this.commands.execute(
      new PutSecretCommand(a, o, p, gate, name, sealed),
    );
  }
  previewRelease(
    a: string,
    o: string,
    p: string,
    gate: string,
  ): Promise<PreviewReleaseResult> {
    return this.queries.execute(new PreviewReleaseQuery(a, o, p, gate));
  }
  release(
    a: string,
    o: string,
    p: string,
    gate: string,
    digest: string,
  ): Promise<ReleaseResult> {
    return this.commands.execute(new ReleaseCommand(a, o, p, gate, digest));
  }
  uploadBundle(
    a: string,
    o: string,
    p: string,
    gate: string,
    envelope: string,
  ): Promise<UploadBundleResult> {
    return this.commands.execute(
      new UploadBundleCommand(a, o, p, gate, envelope),
    );
  }
  pull(token: string): Promise<string | null> {
    return this.queries.execute(new PullBundleQuery(token));
  }
}
