const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const os = require('os');
const winston = require('winston');

// Configuration
const config = {
    homeDirectory: os.homedir(),
    archiveDays: 90,
    ignorePatterns: ['.DS_Store', 'Thumbs.db', '.*.swp'],
    folders: {
        documents: ['.txt', '.pdf', '.doc', '.docx', '.rtf', '.pages', '.odt'],
        images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.heic', '.raw', '.avif'],
        videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv'],
        audio: ['.mp3', '.wav', '.aac', '.flac', '.m4a'],
        archives: ['.zip', '.rar', '.7z', '.tar', '.gz'],
        applications: ['.exe', '.dmg', '.pkg', '.deb', '.appimage', '.msi'],
        code: ['.js','.tsx', '.py', '.java', '.cpp', '.h', '.css', '.html', '.php', '.rb'],
        data: ['.csv', '.xls', '.xlsx', '.json', '.xml', '.yaml'],
        databases: ['.sql', '.db', '.sqlite', '.sqlite3'],
        design: ['.ai', '.psd', '.sketch', '.fig', '.xd'],
        presentations: ['.ppt', '.pptx', '.key']
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
                const basename = path.basename(filePath);
                return config.ignorePatterns.some(pattern => {
                    const regex = new RegExp(pattern);
                    return regex.test(basename);
                }) || !fsSync.statSync(filePath).isFile(); // Ignore directories
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
            const shouldArchive = fileAge > config.archiveDays * 24 * 60 * 60 * 1000;

            if (shouldArchive) {
                await this.moveFile(filePath, this.archiveFolder);
                return;
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
