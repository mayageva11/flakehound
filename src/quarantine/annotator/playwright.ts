import type { CallExpression, Node as TsNode, SourceFile } from 'ts-morph';
import { writeFileAtomic } from '../../util/atomic-write.js';
import { buildMarkerComment, isMarkerComment, parseMarkerComment } from '../marker.js';
import { QUARANTINE_TAG } from '../types.js';
import type {
  AnnotateResult,
  AnnotationTarget,
  MarkerInfo,
  QuarantineAnnotator,
} from '../types.js';

/**
 * ts-morph bundles the whole TypeScript compiler — load it lazily so commands
 * that never touch quarantine (analyze, explain) pay nothing for it.
 */
type TsMorph = typeof import('ts-morph');
let tsMorph: TsMorph | undefined;
async function loadTsMorph(): Promise<TsMorph> {
  tsMorph ??= await import('ts-morph');
  return tsMorph;
}

/** Modifiers under which a test declaration still carries (title, [options], body). */
const TEST_MODIFIERS = new Set(['only', 'fixme', 'skip', 'fail']);
const DESCRIBE_MODIFIERS = new Set(['only', 'serial', 'parallel', 'fixme', 'skip']);

type TestMatch = { call: CallExpression } | { error: AnnotateResult };

/**
 * Quarantines Playwright tests by attaching QUARANTINE_TAG (the ≥1.42
 * `test(title, { tag }, body)` form) plus a marker comment, and reverses both
 * on release. Edits are surgical AST operations so unrelated code and
 * formatting are untouched; every uncertain situation returns
 * 'not-found'/'ambiguous' instead of editing.
 */
export class PlaywrightAnnotator implements QuarantineAnnotator {
  readonly name = 'playwright';
  readonly tag = QUARANTINE_TAG;

  async quarantine(
    target: AnnotationTarget,
    marker: MarkerInfo,
    opts: { dryRun: boolean },
  ): Promise<AnnotateResult> {
    const m = await loadTsMorph();
    const sourceFile = openSourceFile(m, target.filePath);
    const found = findTestCall(m, sourceFile, target);
    if ('error' in found) return found.error;

    const tagPresent = hasTag(m, found.call, this.tag);
    const markerPresent = markerLine(m, sourceFile, found.call) !== undefined;
    // Both halves present → done. One half missing (a human deleted it) → repair it.
    if (tagPresent && markerPresent) return { status: 'already-annotated' };

    if (!tagPresent) {
      const failure = addTag(m, found.call, this.tag);
      if (failure !== undefined) return failure;
    }
    if (!markerPresent) {
      // AST manipulation invalidates node references — re-locate before the text edit.
      const refound = findTestCall(m, sourceFile, target);
      if ('error' in refound) return refound.error;
      const statement = refound.call.getFirstAncestorByKind(m.SyntaxKind.ExpressionStatement);
      if (statement === undefined) {
        return { status: 'not-found', detail: `test '${target.testTitle}' is not a plain statement` };
      }
      const indent = statement.getIndentationText();
      sourceFile.insertText(statement.getStart(), `${buildMarkerComment(marker)}\n${indent}`);
    }

    if (!opts.dryRun) await writeFileAtomic(target.filePath, sourceFile.getFullText());
    return { status: 'annotated', filePath: target.filePath };
  }

  async release(target: AnnotationTarget, opts: { dryRun: boolean }): Promise<AnnotateResult> {
    const m = await loadTsMorph();
    const sourceFile = openSourceFile(m, target.filePath);
    const found = findTestCall(m, sourceFile, target);
    if ('error' in found) return found.error;

    const tagPresent = hasTag(m, found.call, this.tag);
    const markerAt = markerLine(m, sourceFile, found.call);
    if (!tagPresent && markerAt === undefined) return { status: 'already-annotated' };

    if (tagPresent) {
      const failure = removeTag(m, found.call, this.tag);
      if (failure !== undefined) return failure;
    }

    let text = sourceFile.getFullText();
    // Re-locate after the AST edit, then drop the marker line with a text splice.
    const refound = findTestCall(m, sourceFile, target);
    if (!('error' in refound)) {
      const at = markerLine(m, sourceFile, refound.call);
      if (at !== undefined) {
        const lines = text.split('\n');
        lines.splice(at, 1);
        text = lines.join('\n');
      }
    }

    if (!opts.dryRun) await writeFileAtomic(target.filePath, text);
    return { status: 'annotated', filePath: target.filePath };
  }

  async readMarker(target: AnnotationTarget): Promise<MarkerInfo | undefined> {
    const m = await loadTsMorph();
    const sourceFile = openSourceFile(m, target.filePath);
    const found = findTestCall(m, sourceFile, target);
    if ('error' in found) return undefined;
    const at = markerLine(m, sourceFile, found.call);
    if (at === undefined) return undefined;
    const line = sourceFile.getFullText().split('\n')[at];
    return line === undefined ? undefined : parseMarkerComment(line);
  }
}

function openSourceFile(m: TsMorph, filePath: string): SourceFile {
  // Never load the user's tsconfig: one isolated file per operation.
  const project = new m.Project({ skipAddingFilesFromTsConfig: true });
  return project.addSourceFileAtPath(filePath);
}

/** Callee chain of a call, e.g. test.describe.only → ['test','describe','only']. */
function calleePath(m: TsMorph, call: CallExpression): string[] | undefined {
  let expr = call.getExpression();
  const names: string[] = [];
  while (m.Node.isPropertyAccessExpression(expr)) {
    names.unshift(expr.getName());
    expr = expr.getExpression();
  }
  if (!m.Node.isIdentifier(expr)) return undefined;
  names.unshift(expr.getText());
  return names;
}

function isTestDeclaration(m: TsMorph, call: CallExpression): boolean {
  const chain = calleePath(m, call);
  if (chain === undefined || chain[0] !== 'test') return false;
  if (chain.length === 1) return true;
  // Whitelist, not "anything but describe": test.step()/test.use() also take strings.
  return chain.length === 2 && TEST_MODIFIERS.has(chain[1]!);
}

function isDescribeDeclaration(m: TsMorph, call: CallExpression): boolean {
  const chain = calleePath(m, call);
  if (chain === undefined || chain[0] !== 'test' || chain[1] !== 'describe') return false;
  if (chain.length === 2) return true;
  return chain.length === 3 && DESCRIBE_MODIFIERS.has(chain[2]!);
}

/** Literal title of a call's first argument; computed titles → undefined. */
function literalTitle(m: TsMorph, call: CallExpression): string | undefined {
  const first = call.getArguments()[0];
  if (first === undefined) return undefined;
  if (m.Node.isStringLiteral(first) || m.Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralText();
  }
  return undefined;
}

/** Enclosing describe titles, outermost first. */
function describeChain(m: TsMorph, call: CallExpression): string[] {
  const titles: string[] = [];
  for (const ancestor of call.getAncestors()) {
    if (m.Node.isCallExpression(ancestor) && isDescribeDeclaration(m, ancestor)) {
      const title = literalTitle(m, ancestor);
      if (title !== undefined) titles.unshift(title);
    }
  }
  return titles;
}

function findTestCall(m: TsMorph, sourceFile: SourceFile, target: AnnotationTarget): TestMatch {
  const byTitle = sourceFile
    .getDescendantsOfKind(m.SyntaxKind.CallExpression)
    .filter(
      (call) => isTestDeclaration(m, call) && literalTitle(m, call) === target.testTitle,
    );

  if (byTitle.length === 0) {
    return {
      error: {
        status: 'not-found',
        detail: `no test titled '${target.testTitle}' in ${target.filePath} (computed titles are not matchable)`,
      },
    };
  }
  if (byTitle.length === 1) return { call: byTitle[0]! };

  const byChain = byTitle.filter(
    (call) => JSON.stringify(describeChain(m, call)) === JSON.stringify(target.describePath),
  );
  if (byChain.length === 1) return { call: byChain[0]! };
  return {
    error: {
      status: 'ambiguous',
      detail: `${byTitle.length} tests titled '${target.testTitle}' in ${target.filePath} and the describe chain does not single one out`,
    },
  };
}

/** The tag property of a test's options object, if the shape is analyzable. */
function tagInitializer(m: TsMorph, call: CallExpression) {
  const options = call.getArguments()[1];
  if (options === undefined || !m.Node.isObjectLiteralExpression(options)) return undefined;
  const prop = options.getProperty('tag');
  if (prop === undefined || !m.Node.isPropertyAssignment(prop)) return undefined;
  return { options, prop, init: prop.getInitializer() };
}

function isLiteralWithText(m: TsMorph, node: TsNode | undefined, text: string): boolean {
  return (
    (m.Node.isStringLiteral(node) || m.Node.isNoSubstitutionTemplateLiteral(node)) &&
    node.getLiteralText() === text
  );
}

function hasTag(m: TsMorph, call: CallExpression, tag: string): boolean {
  const found = tagInitializer(m, call);
  if (found?.init === undefined) return false;
  if (isLiteralWithText(m, found.init, tag)) return true;
  if (m.Node.isArrayLiteralExpression(found.init)) {
    return found.init.getElements().some((el) => isLiteralWithText(m, el, tag));
  }
  return false;
}

/** Attach the tag. Returns a failure result, or undefined on success. */
function addTag(m: TsMorph, call: CallExpression, tag: string): AnnotateResult | undefined {
  const args = call.getArguments();
  if (args.length < 2) {
    return { status: 'not-found', detail: 'test call has no body argument' };
  }
  if (args.length === 2) {
    call.insertArgument(1, `{ tag: '${tag}' }`);
    return undefined;
  }
  const options = args[1]!;
  if (!m.Node.isObjectLiteralExpression(options)) {
    return { status: 'ambiguous', detail: 'test options are not an object literal — not editing' };
  }
  const prop = options.getProperty('tag');
  if (prop === undefined) {
    options.addPropertyAssignment({ name: 'tag', initializer: `'${tag}'` });
    return undefined;
  }
  if (!m.Node.isPropertyAssignment(prop)) {
    return { status: 'ambiguous', detail: 'tag property is not a plain assignment — not editing' };
  }
  const init = prop.getInitializer();
  if (init !== undefined && m.Node.isArrayLiteralExpression(init)) {
    init.addElement(`'${tag}'`);
    return undefined;
  }
  if (init !== undefined && (m.Node.isStringLiteral(init) || m.Node.isNoSubstitutionTemplateLiteral(init))) {
    prop.setInitializer(`[${init.getText()}, '${tag}']`);
    return undefined;
  }
  return { status: 'ambiguous', detail: 'tag value is not a string or array literal — not editing' };
}

/** Remove the tag, restoring the original shape where we created it. */
function removeTag(m: TsMorph, call: CallExpression, tag: string): AnnotateResult | undefined {
  const found = tagInitializer(m, call);
  if (found === undefined || found.init === undefined) return undefined;
  const { options, prop, init } = found;
  const soleProperty = options.getProperties().length === 1;

  if (isLiteralWithText(m, init, tag)) {
    // `{ tag: '@flakehound-quarantined' }` and nothing else → we created the
    // options argument; removing it restores the original two-arg call.
    if (soleProperty) call.removeArgument(1);
    else prop.remove();
    return undefined;
  }

  if (m.Node.isArrayLiteralExpression(init)) {
    const kept = init
      .getElements()
      .filter((el) => !isLiteralWithText(m, el, tag))
      .map((el) => el.getText());
    if (kept.length === init.getElements().length) return undefined; // ours not present
    if (kept.length === 0) {
      if (soleProperty) call.removeArgument(1);
      else prop.remove();
    } else if (kept.length === 1) {
      // Collapse to the bare value — restores `tag: '@slow'` we arrayified.
      prop.setInitializer(kept[0]!);
    } else {
      prop.setInitializer(`[${kept.join(', ')}]`);
    }
    return undefined;
  }

  return { status: 'ambiguous', detail: 'tag value is not a string or array literal — not editing' };
}

/** 0-based line index of the marker comment directly above the test, if any. */
function markerLine(m: TsMorph, sourceFile: SourceFile, call: CallExpression): number | undefined {
  const statement = call.getFirstAncestorByKind(m.SyntaxKind.ExpressionStatement);
  if (statement === undefined) return undefined;
  const { line } = sourceFile.getLineAndColumnAtPos(statement.getStart());
  const previous = sourceFile.getFullText().split('\n')[line - 2];
  return previous !== undefined && isMarkerComment(previous) ? line - 2 : undefined;
}
