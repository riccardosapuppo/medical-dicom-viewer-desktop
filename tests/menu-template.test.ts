/**
 * What is in the menu bar.
 *
 * This is the first thing anybody opening the application looks at, and it has
 * been wrong twice with nothing to notice it. The first time it was Electron's
 * own developer menu, left in because no menu had been set at all. The second
 * time it was set correctly and still wrong, because the flag that hides the
 * developer entries was true whenever the application was not packaged — so
 * everybody who ran it from its own source got the debug build, which is
 * everybody who will ever look at this repository.
 *
 * A test could not read the menu before: building one needs a running
 * application. The template is now data, so it can be read here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { menuTemplate, type MenuActions } from '../src/main/menu-template';

function nothing(): void {}

const ACTIONS: MenuActions = {
  openFolder: nothing,
  openFiles: nothing,
  openSample: nothing,
  hasDemoStudies: true,
  closeStudy: nothing,
  showScreens: nothing,
  showAbout: nothing,
  recent: [],
  openRecent: nothing,
  openProjectPage: nothing,
};

interface Item {
  label?: string;
  role?: string;
  submenu?: Item[];
  enabled?: boolean;
  accelerator?: string;
}

function template(debug: boolean, onMac = false): Item[] {
  return menuTemplate({
    actions: ACTIONS,
    debug,
    appName: 'DICOM Workstation',
    onMac,
  }) as Item[];
}

/** Every item in the menu, at any depth. */
function everything(items: Item[]): Item[] {
  return items.flatMap(item => [item, ...(item.submenu ? everything(item.submenu) : [])]);
}

function roles(items: Item[]): string[] {
  return everything(items)
    .map(item => item.role)
    .filter((role): role is string => role !== undefined);
}

function labels(items: Item[]): string[] {
  return everything(items)
    .map(item => item.label)
    .filter((label): label is string => label !== undefined);
}

const DEVELOPER = ['reload', 'forceReload', 'toggleDevTools'];

test('an ordinary run offers nothing to reload or inspect with', () => {
  const present = roles(template(false));

  for (const role of DEVELOPER) {
    assert.equal(present.includes(role), false, `${role} is in the menu of a normal run`);
  }

  // The words too: a role is not the only way to end up with one of these.
  const said = labels(template(false)).join(' | ').toLowerCase();
  assert.equal(said.includes('reload'), false);
  assert.equal(said.includes('developer'), false);
  assert.equal(said.includes('devtools'), false);
});

test('asking for them by name brings them back', () => {
  const present = roles(template(true));

  for (const role of DEVELOPER) {
    assert.ok(present.includes(role), `${role} is missing from a --debug run`);
  }
});

test('what a person came for is there either way', () => {
  for (const debug of [false, true]) {
    const said = labels(template(debug));

    assert.ok(said.includes('Open Folder…'), 'a folder can be opened');
    assert.ok(said.includes('Screens…'), 'the screens can be seen');
    assert.ok(
      said.some(label => label.startsWith('About ')),
      'the version and the author can be read'
    );
  }
});

test('nothing points at Electron', () => {
  // The default menu's Help entry opens electronjs.org, which tells anybody who
  // looks exactly what they are holding.
  const said = labels(template(false)).join(' ').toLowerCase();
  assert.equal(said.includes('electron'), false);
});

test('the demonstration studies are offered only once they are there', () => {
  const offered = (has: boolean): Item | undefined =>
    everything(menuTemplate({ actions: { ...ACTIONS, hasDemoStudies: has }, debug: false, appName: 'x', onMac: false }) as Item[])
      .find(item => item.label === 'Open Demonstration Studies');

  assert.equal(offered(true)?.enabled, true);
  // Greyed out reads as something not set up yet, which is what it is. An entry
  // that is there and does nothing reads as a broken application.
  assert.equal(offered(false)?.enabled, false);
});

test('the recent folders are listed, shortened, with the whole path to hand', () => {
  const withRecent = menuTemplate({
    actions: {
      ...ACTIONS,
      recent: ['C:/studies/2024/april', '/mnt/archive/chest'],
    },
    debug: false,
    appName: 'x',
    onMac: false,
  }) as Item[];

  const said = labels(withRecent);
  assert.ok(said.includes('Open Recent'));
  assert.ok(
    said.some(label => label.includes('2024') && label.includes('april')),
    'a folder is named by the part that identifies it'
  );
});

test('the mac build puts the application menu first, and About in it', () => {
  const mac = template(false, true);

  assert.equal(mac[0]?.label, 'DICOM Workstation');
  assert.ok(labels([mac[0] as Item]).includes('About DICOM Workstation'));

  // And then it is not repeated under Help, which is where it lives everywhere
  // else.
  const help = mac.find(item => item.label === '&Help');
  assert.equal(
    labels(help ? [help] : []).some(label => label.startsWith('About ')),
    false
  );
});
