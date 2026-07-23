import web from '@node-core/doc-kit/src/generators/web/index.mjs';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin =
  process.env.VERCEL_ENV === 'preview'
    ? process.env.VERCEL_URL
    : 'calimanco.github.io';

const tempRoot = mkdtempSync(join(tmpdir(), 'nodejs-learn-cn-'));
const stagedPagesRoot = join(tempRoot, 'pages');

cpSync(join(import.meta.dirname, 'pages'), stagedPagesRoot, {
  recursive: true,
});

const walk = dirPath =>
  readdirSync(dirPath, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(dirPath, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });

for (const filePath of walk(stagedPagesRoot)) {
  if (!filePath.endsWith('.md')) {
    continue;
  }

  const original = readFileSync(filePath, 'utf8');
  const updated = original.replace(
    /\/learn(?=\/|$)/g,
    '/nodejs-learn-cn/learn'
  );

  if (updated !== original) {
    writeFileSync(filePath, updated);
  }
}

process.on('exit', () => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** @type {import('@node-core/doc-kit/src/utils/configuration/types.d.ts').Configuration} */
export default {
  global: {
    output: 'out/learn',
    input: [join(stagedPagesRoot, '**/*.md')],
    baseURL: `https://${origin}/nodejs-learn-cn/learn`,
  },
  'jsx-ast': {
    generateIndexPage: false,
  },
  web: {
    // Important Configuration
    project: 'Node.js',
    title: '{project} Learn',
    pageURL: '{baseURL}{path}.html',
    editURL: 'https://github.com/nodejs/learn/edit/main/pages{path}.md',
    useAbsoluteURLs: true,
    templatePath: join(import.meta.dirname, 'template.html'),

    // Imports
    imports: {
      ...web.defaultConfiguration.imports,
      '#theme/Layout': join(import.meta.dirname, 'components/Layout/index.jsx'),
    },
  },
  sitemap: {
    indexURL: '{baseURL}',
    pageURL: '{baseURL}{path}',
  },
};
