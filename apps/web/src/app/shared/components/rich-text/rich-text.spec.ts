import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RichText, segments } from './rich-text';

describe('segments', () => {
  it('splits commands written as `…` from the text', () => {
    expect(segments('Run `moat build <gate>` now.')).toEqual([
      { code: false, text: 'Run ' },
      { code: true, text: 'moat build <gate>' },
      { code: false, text: ' now.' },
    ]);
    expect(segments('plain')).toEqual([{ code: false, text: 'plain' }]);
    expect(segments('`a``b`')).toEqual([
      { code: true, text: 'a' },
      { code: true, text: 'b' },
    ]);
  });
});

@Component({
  imports: [RichText],
  template: `<mt-rich-text [text]="text" />`,
})
class Host {
  text = 'Add one with `moat gate add`, then <b>seal</b>.';
}

describe('RichText', () => {
  it('renders code as text nodes, without stray spaces and without HTML', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toBe(
      'Add one with moat gate add, then <b>seal</b>.',
    );
    expect(element.querySelector('code')?.textContent).toBe('moat gate add');
    expect(element.querySelector('b')).toBeNull();
  });
});
