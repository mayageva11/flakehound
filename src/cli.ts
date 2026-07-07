#!/usr/bin/env node
import { Command } from 'commander';
import { runExplain } from './explain.js';
import { VERSION } from './index.js';
import { runAnalyze } from './run.js';
import { FlakehoundError } from './util/errors.js';

const program = new Command();

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
        // Exit 2 = the tool broke (parse error, bad config) — distinct from
        // exit 1 (a new regression was found) so CI can tell them apart.
        if (error instanceof FlakehoundError) {
          console.error(`flakehound: ${error.message}`);
        } else {
          console.error(error);
        }
        process.exitCode = 2;
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
      if (error instanceof FlakehoundError) {
        console.error(`flakehound: ${error.message}`);
      } else {
        console.error(error);
      }
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv);
