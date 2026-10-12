import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RowActions, type RowAction } from './row-actions';

@Component({
  imports: [RowActions],
  template: `<mt-row-actions
    [actions]="actions()"
    name="newsletter"
    (run)="ran.push($event)"
  />`,
})
class Host {
  readonly actions = signal<readonly RowAction[]>([]);
  readonly ran: string[] = [];
}

async function render(actions: readonly RowAction[]) {
  TestBed.configureTestingModule({ providers: [provideTranslateService()] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.actions.set(actions);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('RowActions', () => {
  it('shows a single action as a plain button, without a menu', async () => {
    const { fixture, el } = await render([{ id: 'lock', labelKey: 'x.lock' }]);
    expect(el.querySelector('[data-row-actions]')).toBeNull();
    (el.querySelector('[data-action="lock"]') as HTMLButtonElement).click();
    expect(fixture.componentInstance.ran).toEqual(['lock']);
  });

  it('puts two or more actions behind one "…" button with a label naming the row', async () => {
    const { fixture, el } = await render([
      { id: 'edit', labelKey: 'x.edit' },
      { id: 'remove', labelKey: 'x.remove', destructive: true },
    ]);
    const trigger = el.querySelector('[data-row-actions]') as HTMLButtonElement;
    expect(el.querySelector('[data-action]')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('common.actionsFor');
    trigger.click();
    await fixture.whenStable();
    const remove = document.querySelector(
      '[data-row-actions-menu] [data-action="remove"]',
    ) as HTMLButtonElement;
    expect(remove.getAttribute('data-variant')).toBe('destructive');
    remove.click();
    expect(fixture.componentInstance.ran).toEqual(['remove']);
  });
});
