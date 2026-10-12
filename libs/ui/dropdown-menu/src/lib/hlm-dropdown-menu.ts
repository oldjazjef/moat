import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { Directive, inject, input } from '@angular/core';
import { classes } from '@moat/ui/utils';

/** Opens the menu below the trigger, aligned to its end (row actions sit at the right edge). */
@Directive({
	selector: '[hlmDropdownMenuTrigger]',
	hostDirectives: [{ directive: CdkMenuTrigger, inputs: ['cdkMenuTriggerFor: hlmDropdownMenuTrigger'] }],
	host: { 'data-slot': 'dropdown-menu-trigger' },
})
export class HlmDropdownMenuTrigger {
	constructor() {
		inject(CdkMenuTrigger).menuPosition = [
			{ originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 4 },
			{ originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -4 },
		];
	}
}

@Directive({
	selector: '[hlmDropdownMenu],hlm-dropdown-menu',
	hostDirectives: [CdkMenu],
	host: { 'data-slot': 'dropdown-menu' },
})
export class HlmDropdownMenu {
	constructor() {
		classes(
			() =>
				'bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 flex min-w-36 flex-col rounded-md border p-1 shadow-md',
		);
	}
}

@Directive({
	selector: '[hlmDropdownMenuItem]',
	hostDirectives: [
		{ directive: CdkMenuItem, inputs: ['cdkMenuItemDisabled: disabled'], outputs: ['cdkMenuItemTriggered: triggered'] },
	],
	host: {
		'data-slot': 'dropdown-menu-item',
		'[attr.data-variant]': 'variant()',
	},
})
export class HlmDropdownMenuItem {
	readonly variant = input<'default' | 'destructive'>('default');

	constructor() {
		classes(
			() =>
				'focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:hover:bg-destructive/10 relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
		);
	}
}
