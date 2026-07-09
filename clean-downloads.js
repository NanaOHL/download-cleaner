const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const os = require('os');
const winston = require('winston');
const Anthropic = require('@anthropic-ai/sdk').default;
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Configuration
const config = {
    homeDirectory: os.homedir(),
    archiveDays: 365,
    ignorePatterns: ['.DS_Store', 'Thumbs.db', '.*.swp'],
    folders: {
        documents: ['.txt', '.pdf', '.doc', '.docx', '.rtf', '.pages', '.odt', '.md', '.epub', '.mobi', '.tex', '.wpd', '.wps', '.xps'],
        images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.heic', '.raw', '.bmp', '.tiff', '.tif', '.ico', '.avif', '.cr2', '.nef', '.arw', '.dng'],
        videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ogv', '.vob', '.ts', '.mts'],
        audio: ['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus', '.wma', '.aiff', '.mid', '.midi', '.amr'],
        archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tar.gz', '.tar.bz2', '.cab', '.iso'],
        applications: ['.exe', '.dmg', '.pkg', '.deb', '.appimage', '.msi', '.apk', '.ipa', '.snap', '.flatpak', '.rpm'],
        code: ['.js', '.tsx', '.ts', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.css', '.html', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.lua', '.r', '.m', '.vue', '.svelte'],
        data: ['.csv', '.numbers', '.xls', '.xlsx', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.tsv', '.parquet', '.geojson'],
        databases: ['.sql', '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb'],
        design: ['.ai', '.psd', '.sketch', '.fig', '.xd', '.eps', '.indd', '.afdesign', '.afphoto', '.cdr', '.xcf'],
        presentations: ['.ppt', '.pptx', '.key', '.odp'],
        fonts: ['.ttf', '.otf', '.woff', '.woff2', '.eot'],
        ebooks: ['.epub', '.mobi', '.azw', '.azw3', '.lit', '.lrf']
    }
};

// Initialize logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

class DownloadsOrganizer {
    constructor() {
        this.downloadFolder = path.join(config.homeDirectory, 'Downloads');
        this.archiveFolder = path.join(this.downloadFolder, '_Archive');
        this.extensionMap = this.buildExtensionMap();
        this.knownFiles = new Set(); // Track files we've already processed
        this.anthropic = process.env.ANTHROPIC_API_KEY
            ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
            : null;
    }

    async generateSmartFileName(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const today = new Date().toISOString().slice(0, 10);

        if (!this.anthropic) {
            logger.warn('ANTHROPIC_API_KEY not set — skipping smart rename');
            return null;
        }

        try {
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.avif']);
            const pdfExt = ext === '.pdf';
            const textExts = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.rtf']);

            let messages;

            if (pdfExt) {
                const buffer = fsSync.readFileSync(filePath);
                const data = await pdfParse(buffer, { max: 3 }); // first 3 pages
                const snippet = data.text.slice(0, 3000).trim();
                if (!snippet) return null;

                messages = [{
                    role: 'user',
                    content: `Based on this document content, generate a short descriptive filename (no extension, no path).

Rules:
- Use lowercase letters, numbers, and underscores only
- Format depends on document type:
  - Invoice: invoice_<company>_<inv_number>_<amount>_<date>
  - Receipt: receipt_<merchant>_<ref_number>_<amount>_<date>
  - Purchase Order: po_<company>_<po_number>_<date>
  - Contract/Agreement: contract_<parties>_<ref_number>_<date>
  - Statement: statement_<bank_or_company>_<ref_number>_<date>
  - Report: report_<topic>_<ref_number>_<date>
  - Article/Paper: article_<title_slug>
  - Resume/CV: resume_<name>
  - Other: <type>_<description>_<ref_number>_<date>
- For <inv_number>/<ref_number>/<po_number>: extract invoice numbers (e.g. INV-1234), reference numbers, PO numbers, order numbers, case numbers, or any unique document identifier — omit if none found
- Replace spaces with underscores
- Keep it under 60 characters
- Use today's date (${today}) if no date found in document
- Return ONLY the filename, nothing else

Document content:
${snippet}`
                }];

            } else if (imageExts.has(ext)) {
                const mediaTypeMap = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.gif': 'image/gif', '.webp': 'image/webp'
                };
                const mediaType = mediaTypeMap[ext];
                if (!mediaType) return null; // heic/avif not supported by API vision

                const imageData = fsSync.readFileSync(filePath).toString('base64');

                messages = [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: { type: 'base64', media_type: mediaType, data: imageData }
                        },
                        {
                            type: 'text',
                            text: `Generate a short descriptive filename for this image (no extension, no path).

Rules:
- Use lowercase letters, numbers, and underscores only
- Format: <type>_<description> e.g. screenshot_dashboard_overview, photo_golden_gate_bridge, receipt_starbucks_coffee
- Keep it under 60 characters
- Return ONLY the filename, nothing else`
                        }
                    ]
                }];

            } else if (textExts.has(ext)) {
                const content = await fs.readFile(filePath, 'utf8');
                const snippet = content.slice(0, 3000).trim();
                if (!snippet) return null;

                messages = [{
                    role: 'user',
                    content: `Based on this file content, generate a short descriptive filename (no extension, no path).

Rules:
- Use lowercase letters, numbers, and underscores only
- Include any invoice numbers, reference numbers, order numbers, or unique document identifiers found in the content
- Keep it under 60 characters
- Return ONLY the filename, nothing else

Content:
${snippet}`
                }];

            } else {
                return null; // unsupported type — keep original name
            }

            const response = await this.anthropic.messages.create({
                model: 'claude-opus-4-6',
                max_tokens: 64,
                messages
            });

            const suggested = response.content[0]?.text?.trim()
                .replace(/[^a-z0-9_\-]/gi, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '')
                .toLowerCase();

            return suggested || null;

        } catch (err) {
            logger.warn(`Smart rename failed for ${filePath}: ${err.message}`);
            return null;
        }
    }

    async setArchiveTag(filePath) {
        try {
            // Build binary plist ["archive"] using Python, write via xattr -wx
            const plistScript = `import plistlib, sys; sys.stdout.buffer.write(plistlib.dumps(['archive']))`;
            const { stdout } = await execFileAsync('python3', ['-c', plistScript], { encoding: 'buffer' });
            await execFileAsync('xattr', ['-wx', 'com.apple.metadata:_kMDItemUserTags', stdout.toString('hex'), filePath]);
            logger.info(`Archive tag set: ${path.basename(filePath)}`);
        } catch (err) {
            logger.warn(`Failed to set archive tag on ${path.basename(filePath)}: ${err.message}`);
        }
    }

    buildExtensionMap() {
        const map = new Map();
        Object.entries(config.folders).forEach(([folder, extensions]) => {
            extensions.forEach(ext => map.set(ext.toLowerCase(), folder));
        });
        return map;
    }

    async initialize() {
        try {
            await this.ensureDirectoryExists(this.archiveFolder);
            await this.ensureDirectoriesExist();
            await this.loadExistingFiles(); // Load existing files before starting watcher
            this.startWatcher();
            await this.organizeFiles();
            logger.info('Downloads organizer initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize downloads organizer', { error });
            throw error;
        }
    }

    async loadExistingFiles() {
        const files = await fs.readdir(this.downloadFolder);
        for (const file of files) {
            const filePath = path.join(this.downloadFolder, file);
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
                this.knownFiles.add(filePath);
            }
        }
    }

    async ensureDirectoryExists(dirPath) {
        try {
            await fs.access(dirPath);
        } catch {
            await fs.mkdir(dirPath, { recursive: true });
            logger.info(`Created directory: ${dirPath}`);
        }
    }

    async ensureDirectoriesExist() {
        const directories = Object.keys(config.folders);
        for (const dir of directories) {
            await this.ensureDirectoryExists(path.join(this.downloadFolder, dir));
        }
    }

    startWatcher() {
        // Only watch the Downloads folder directly, not its subdirectories
        const watcher = chokidar.watch(this.downloadFolder, {
            depth: 0, // Only watch the immediate directory
            ignored: (filePath) => {
                // Never ignore the root watch directory itself
                if (filePath === this.downloadFolder) return false;
                const basename = path.basename(filePath);
                if (config.ignorePatterns.some(pattern => new RegExp(pattern).test(basename))) {
                    return true;
                }
                try {
                    return !fsSync.statSync(filePath).isFile();
                } catch {
                    return true; // file gone or inaccessible — ignore it
                }
            },
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        watcher
            .on('add', async filePath => {
                if (!this.knownFiles.has(filePath)) {
                    logger.info(`New file detected: ${filePath}`);
                    this.knownFiles.add(filePath);
                    await this.handleFile(filePath);
                }
            })
            .on('error', error => {
                logger.error('Watcher error', { error });
            });

        logger.info('File watcher started');
    }

    async handleFile(filePath) {
        try {
            // Skip if file no longer exists or is in a subdirectory
            if (!fsSync.existsSync(filePath) || path.dirname(filePath) !== this.downloadFolder) {
                return;
            }

            const stats = await fs.stat(filePath);
            const fileAge = Date.now() - stats.mtime.getTime();
            const isOld = fileAge > config.archiveDays * 24 * 60 * 60 * 1000;

            // Try to generate a smart name before moving
            const ext = path.extname(filePath).toLowerCase();
            const smartBaseName = await this.generateSmartFileName(filePath);

            if (smartBaseName) {
                const newName = `${smartBaseName}${ext}`;
                const newPath = path.join(this.downloadFolder, newName);
                if (newPath !== filePath && !fsSync.existsSync(newPath)) {
                    await fs.rename(filePath, newPath);
                    this.knownFiles.delete(filePath);
                    this.knownFiles.add(newPath);
                    logger.info(`Renamed: ${path.basename(filePath)} → ${newName}`);
                    filePath = newPath;
                }
            }

            if (isOld) {
                await this.setArchiveTag(filePath);
            }

            const extension = path.extname(filePath).toLowerCase();
            const targetFolder = this.extensionMap.get(extension);

            if (targetFolder) {
                const targetPath = path.join(this.downloadFolder, targetFolder);
                await this.moveFile(filePath, targetPath);
            }
        } catch (error) {
            logger.error('Error handling file', { filePath, error });
        }
    }

    async moveFile(sourcePath, targetDir) {
        try {
            const filename = path.basename(sourcePath);
            let targetPath = path.join(targetDir, filename);
            
            // Handle file name conflicts
            if (fsSync.existsSync(targetPath)) {
                const ext = path.extname(filename);
                const nameWithoutExt = path.basename(filename, ext);
                const timestamp = Date.now();
                targetPath = path.join(targetDir, `${nameWithoutExt}_${timestamp}${ext}`);
            }

            await fs.rename(sourcePath, targetPath);
            this.knownFiles.delete(sourcePath);
            this.knownFiles.add(targetPath);
            logger.info(`Moved file: ${sourcePath} → ${targetPath}`);
        } catch (error) {
            logger.error('Error moving file', { sourcePath, targetDir, error });
            throw error;
        }
    }

    async organizeFiles() {
        try {
            const files = await fs.readdir(this.downloadFolder);
            
            for (const filename of files) {
                const filePath = path.join(this.downloadFolder, filename);
                const stats = await fs.stat(filePath);
                
                if (stats.isFile() && path.dirname(filePath) === this.downloadFolder) {
                    await this.handleFile(filePath);
                }
            }
            
            logger.info('Initial organization completed');
        } catch (error) {
            logger.error('Error during organization', { error });
        }
    }
}

// Start the organizer
const organizer = new DownloadsOrganizer();
organizer.initialize().catch(error => {
    logger.error('Failed to start downloads organizer', { error });
    process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
});
