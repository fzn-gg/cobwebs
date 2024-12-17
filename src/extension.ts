import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const execPromise = promisify(exec);

interface LineCommitInfo {
    lineNumber: number;
    timestamp: number;
}

const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1.0;

export async function activate(context: vscode.ExtensionContext) {
    let decorationTypes: vscode.TextEditorDecorationType[] = [];

    const updateDecorationsHandler = async (editor: vscode.TextEditor | undefined) => {
        if (!editor) { return; }
        
        // Clear old decorations
        for (const d of decorationTypes) {
            d.dispose();
        }
        decorationTypes = [];
        
        await updateDecorations(editor.document, decorationTypes);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateDecorationsHandler),
        vscode.workspace.onDidOpenTextDocument(doc => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === doc) {
                updateDecorationsHandler(editor);
            }
        })
    );

    if (vscode.window.activeTextEditor) {
        await updateDecorationsHandler(vscode.window.activeTextEditor);
    }
}

export function deactivate() {}

async function updateDecorations(
    doc: vscode.TextDocument, 
    decorationTypes: vscode.TextEditorDecorationType[]
) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || doc.isUntitled) { return; }

    const lineData = await getLineCommitTimes(doc.fileName);
    if (!lineData?.length) { return; }

    applyDecorations(editor, lineData, decorationTypes);
}

async function getLineCommitTimes(filePath: string): Promise<LineCommitInfo[] | null> {
    try {
        const { stdout: gitRoot } = await execPromise('git rev-parse --show-toplevel', {
            cwd: dirname(filePath)
        });
        
        if (!gitRoot.trim()) { return null; }

        const { stdout } = await execPromise(
            `git blame --line-porcelain "${filePath}"`,
            { cwd: dirname(filePath) }
        );

        const results = new Map<number, number>();
        let currentEntry = { lineNumber: -1, timestamp: 0 };

        const lines = stdout.split('\n');
        for (const line of lines) {
            const headerMatch = line.match(/^[0-9a-f]{40} (\d+)/);
            if (headerMatch) {
                if (currentEntry.lineNumber !== -1 && currentEntry.timestamp !== 0) {
                    results.set(currentEntry.lineNumber - 1, currentEntry.timestamp);
                }
                currentEntry = {
                    lineNumber: Number.parseInt(headerMatch[1], 10),
                    timestamp: 0
                };
                continue;
            }

            if (line.startsWith('author-time ')) {
                currentEntry.timestamp = Number.parseInt(line.split(' ')[1], 10);
            }
        }

        if (currentEntry.lineNumber !== -1 && currentEntry.timestamp !== 0) {
            results.set(currentEntry.lineNumber - 1, currentEntry.timestamp);
        }

        return Array.from(results, ([lineNumber, timestamp]) => ({
            lineNumber,
            timestamp
        }));

    } catch {
        return null;
    }
}

function applyDecorations(
    editor: vscode.TextEditor,
    lineData: LineCommitInfo[],
    decorationTypes: vscode.TextEditorDecorationType[]
) {
    const now = Math.floor(Date.now() / 1000);
    const ages = lineData.map(info => now - info.timestamp);
    const minAge = Math.min(...ages);
    const maxAge = Math.max(...ages);
    const ageRange = maxAge === minAge ? 1 : maxAge - minAge;
    
    const decorationsByOpacity = new Map<number, vscode.Range[]>();

    for (const { lineNumber, timestamp } of lineData) {
        const age = now - timestamp;
        const normalizedAge = (age - minAge) / ageRange;
        const opacity = MIN_OPACITY + ((1 - normalizedAge) * (MAX_OPACITY - MIN_OPACITY));
        const roundedOpacity = Math.round(opacity * 100) / 100;
        
        const range = new vscode.Range(
            lineNumber, 
            0, 
            lineNumber, 
            Number.MAX_SAFE_INTEGER
        );
        
        const ranges = decorationsByOpacity.get(roundedOpacity) || [];
        ranges.push(range);
        decorationsByOpacity.set(roundedOpacity, ranges);
    }

    for (const [opacity, ranges] of decorationsByOpacity) {
        const decorationType = vscode.window.createTextEditorDecorationType({
            opacity: opacity.toString()
        });
        decorationTypes.push(decorationType);
        editor.setDecorations(decorationType, ranges);
    }
}