/**
 * ParG System - Progress Bundler (Cross-Platform ESM)
 * Role: DevOps / Integration
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

// 1. Generate Filename
const date = new Date();
const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 16);
const outputFilename = `parg-progress-${timestamp}.zip`;

// 2. Define Exclusions (Patterns to ignore)
const exclusions = [
    'node_modules',
    'dist',
    '.output',
    '.git',
    'parg_db_data',
    '*.zip',
    '.DS_Store'
];

console.log(`\x1b[36m[ParG Bundler]\x1b[0m Starting bundle process on \x1b[1m${os.platform()}\x1b[0m...`);

// 3. Construct Command based on OS
let command;
const isWindows = os.platform() === 'win32';

if (isWindows) {
    // Windows 10/11 Native Tar (supports zip via -a)
    // Syntax: tar -a -cf <zipfile> --exclude <pattern> <source>
    const winExclusions = exclusions.map(item => `--exclude "${item}"`).join(' ');
    // We use '.' to capture current directory
    command = `tar -a -cf ${outputFilename} ${winExclusions} .`;
} else {
    // Linux / macOS (Standard Zip)
    // Syntax: zip -r <zipfile> <source> -x <pattern>
    const unixExclusions = exclusions.map(item => `-x "${item}*"`).join(' ');
    command = `zip -r ${outputFilename} . ${unixExclusions}`;
}

// 4. Execute
try {
    console.log(`\x1b[33m[ParG Bundler]\x1b[0m Executing: ${command}`);
    
    // stdio: 'inherit' allows you to see the output in the terminal
    execSync(command, { stdio: 'inherit' });

    // Verify file creation
    if (fs.existsSync(outputFilename)) {
        const stats = fs.statSync(outputFilename);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`\n\x1b[32m[SUCCESS]\x1b[0m Bundle created: \x1b[1m${outputFilename}\x1b[0m`);
        console.log(`Size: ${sizeMB} MB`);
    } else {
        throw new Error("Output file was not found after execution.");
    }

} catch (error) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Bundling failed.`);
    console.error(error.message);
    if (isWindows) {
        console.error(`\n\x1b[33m[Tip]\x1b[0m If 'tar' failed, ensure you are on Windows 10 or newer.`);
        console.error(`Alternatively, use Git Bash to run this script, or run:`);
        console.error(`git archive --format=zip --output=${outputFilename} HEAD`);
    }
}