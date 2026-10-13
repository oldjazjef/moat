import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { setupGuard, SetupStateService } from './setup-state.service';

function guard(url: string): Promise<boolean | UrlTree> {
  return TestBed.runInInjectionContext(
    () =>
      setupGuard(
        {} as ActivatedRouteSnapshot,
        { url } as RouterStateSnapshot,
      ) as Promise<boolean | UrlTree>,
  );
}

async function answer(body: object | null, status = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  const request = TestBed.inject(HttpTestingController).expectOne('/api/setup');
  if (status === 200) request.flush(body);
  else request.flush(null, { status, statusText: 'Error' });
}

describe('setupGuard (FR-73)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }),
  );

  it('opens the wizard instead of any page until it is finished', async () => {
    const result = guard('/app/projects/abc?x=1');
    await answer({ complete: false });
    expect(String(await result)).toBe('/app/setup');
    expect(TestBed.inject(SetupStateService).incomplete()).toBe(true);
  });

  it('leaves the wizard and the help open without asking', async () => {
    expect(await guard('/app/help#gate')).toBe(true);
    expect(await guard('/app/setup?step=gate')).toBe(true);
    TestBed.inject(HttpTestingController).expectNone('/api/setup');
  });

  it('opens pages once the wizard is finished', async () => {
    const done = guard('/app/projects');
    await answer({ complete: true });
    expect(await done).toBe(true);
  });

  it('does not lock the app out when the API cannot be reached', async () => {
    const result = guard('/app/projects');
    await answer(null, 500);
    expect(await result).toBe(true);
  });
});
