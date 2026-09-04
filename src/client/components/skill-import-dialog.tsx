import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Download, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ApiSkillImportPreview } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { Markdown } from './markdown.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Field, Input } from './ui/input.tsx';
import { Pill } from './ui/pill.tsx';

// Verdict → pill tone: audits are free-form strings, so classify loosely.
function auditTone(verdict: string): 'on' | 'red' | null {
  const v = verdict.toLowerCase();
  if (/pass|safe|ok|clean|approved/.test(v)) return 'on';
  if (/fail|unsafe|danger|malicious|reject/.test(v)) return 'red';
  return null;
}

// Mandatory look-before-import view: instructions, files, audit verdicts,
// and the trust warning, with the slug editable when the suggestion is
// already taken. Importing creates an editable local copy.
export function SkillImportDialog({
  reference,
  preview,
  onClose,
}: {
  reference: string;
  preview: ApiSkillImportPreview;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(preview.suggested_slug);
  const [slugEditable, setSlugEditable] = useState(preview.slug_taken);
  const [error, setError] = useState<string | null>(null);

  const importSkill = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; id: number | null }, { reference: string; slug: string }>(
        '/api/skills/import',
        { reference, slug },
      ),
    onSuccess: ({ id }) => {
      toast.success('skill imported');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      if (id !== null) {
        void navigate({ to: '/skills/$skillId/edit', params: { skillId: String(id) } });
      } else {
        void navigate({ to: '/skills' });
      }
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'request failed');
      // A server-side collision means the suggestion raced another import —
      // let the user pick a different slug right here.
      setSlugEditable(true);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogTitle className="flex flex-wrap items-center gap-2 pr-8 text-base font-medium">
          {preview.name} <Pill>{preview.source_ref}</Pill>
        </DialogTitle>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mute">
          <Pill>{preview.source}</Pill>
          {preview.installs !== null ? (
            <span className="tabular-nums">{preview.installs.toLocaleString()} installs</span>
          ) : null}
          {preview.audit === null ? (
            <Pill>no audit yet</Pill>
          ) : (
            preview.audit.map((a, i) => (
              <Pill key={i} tone={auditTone(a.verdict)}>
                {a.auditor}: {a.verdict}
              </Pill>
            ))
          )}
        </div>

        {preview.description ? (
          <p className="mt-2 text-[0.85rem] text-mute">{preview.description}</p>
        ) : null}

        <p className="mt-3 flex items-start gap-2.5 rounded-xl border border-line/70 bg-surface/50 px-3.5 py-3 text-xs leading-relaxed text-mute">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-mute/70" aria-hidden />
          <span>
            This skill's instructions and files run with full repo write access during runs —
            review them before importing.
          </span>
        </p>

        {preview.files.length > 0 ? (
          <div className="mt-3">
            <p className="font-mono text-[10px] font-medium tracking-[0.14em] text-mute uppercase">
              Files
            </p>
            <ul className="mt-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-dim">
              {preview.files.map((f) => (
                <li key={f.path} className="truncate">
                  {f.path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
          <Markdown className="text-[0.8rem]">{preview.instructions}</Markdown>
        </div>

        <div className="mt-3">
          {slugEditable ? (
            <Field
              label="Slug"
              className="mt-0"
              hint={
                preview.slug_taken
                  ? `"${preview.suggested_slug}" is taken — lowercase letters, digits, dashes`
                  : 'lowercase letters, digits, dashes'
              }
            >
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={31}
                className="font-mono"
              />
            </Field>
          ) : (
            <p className="text-xs text-mute">
              Imports as <Pill>{slug}</Pill>
            </p>
          )}
        </div>

        {error ? <p className="mt-2 text-[0.85rem] text-danger">{error}</p> : null}

        <div className="mt-4 flex items-center gap-2">
          <Button onClick={() => importSkill.mutate()} loading={importSkill.isPending}>
            {importSkill.isPending ? null : <Download className="size-4" aria-hidden />}
            Import skill
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
