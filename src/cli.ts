#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { runExplain } from './explain.js';
import { VERSION } from './index.js';
import { runInit } from './init.js';
import { runAnalyze } from './run.js';
import { FlakehoundError } from './util/errors.js';

const program = new Command();

/**
 * Uniform failure path — exit 2 = the tool broke or was misused, distinct from
 * exit 1 (a new regression was found) so CI can tell them apart.
 * FlakehoundErrors are expected states and print as clean guidance; anything
 * else is a bug, condensed to one line (full stack behind FLAKEHOUND_DEBUG=1).
 */
function fail(error: unknown): void {
  if (error instanceof FlakehoundError) {
    console.error(`${pc.red(pc.bold('flakehound:'))} ${error.message}`);
  } else {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${pc.red(pc.bold('flakehound:'))} unexpected error — ${detail}`);
    if (process.env['FLAKEHOUND_DEBUG'] === '1') {
      console.error(error);
    } else {
      console.error(pc.dim('  set FLAKEHOUND_DEBUG=1 for a full stack trace'));
    }
  }
  process.exitCode = 2;
}

program
  .name('flakehound')
  .description('Root-cause analysis for flaky tests — clusters failures by underlying cause.')
  .version(VERSION);

program
  .command('analyze')
  .description('Analyze a history of JUnit XML runs')
  .option('-c, --config <path>', 'path to flakehound config file')
  .option('-i, --input <glob>', 'glob of JUnit XML files (overrides config)')
  .option('-b, --baseline <path>', 'previous flakehound.report.json for the CI gate')
  .option('--no-ai', 'disable the AI interpretation layer')
  .option('--json <path>', 'output path for flakehound.report.json')
  .action(
    async (opts: {
      config?: string;
      input?: string;
      baseline?: string;
      ai: boolean;
      json?: string;
    }) => {
      try {
        const { exitCode } = await runAnalyze({
          ...(opts.config !== undefined ? { configPath: opts.config } : {}),
          overrides: {
            ...(opts.input !== undefined ? { input: opts.input } : {}),
            ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
            ...(opts.json !== undefined ? { output: opts.json } : {}),
            ...(opts.ai === false ? { ai: false } : {}),
          },
        });
        process.exitCode = exitCode;
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command('explain')
  .description("One test's run-by-run story: history, classification reasoning, clusters")
  .argument('<testId>', 'the exact test id from the report (e.g. "shop.spec.ts > checkout")')
  .option('-c, --config <path>', 'path to flakehound config file')
  .option('-i, --input <glob>', 'glob of JUnit XML files (overrides config)')
  .action(async (testId: string, opts: { config?: string; input?: string }) => {
    try {
      await runExplain({
        testId,
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.input !== undefined ? { overrides: { input: opts.input } } : {}),
      });
    } catch (error) {
      fail(error);
    }
  });

program
  .command('init')
  .description('Scaffold a commented flakehound.config.ts in the current directory')
  .option('-f, --force', 'overwrite an existing config file')
  .action(async (opts: { force?: boolean }) => {
    try {
      await runInit({ ...(opts.force === true ? { force: true } : {}) });
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv);
