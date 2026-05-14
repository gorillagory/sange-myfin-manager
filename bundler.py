import os

# --- CONFIGURATION ---
# The directory you want to bundle ('.' means current directory)
PROJECT_ROOT = '.' 

# The output file name
OUTPUT_FILE = 'context_bundle.txt'

# File extensions to include (tailored to your stack)
INCLUDED_EXTENSIONS = {
    '.php', '.js', '.ts', '.vue', '.json', 
    '.css', '.scss', '.html', '.blade.php', 
    '.sql', '.env.example', '.py', '.md'
}

# Directories to strictly ignore
EXCLUDED_DIRS = {
    'node_modules', 'vendor', '.git', '.idea', '.vscode', 
    'dist', 'build', 'coverage', 'storage', 'public/build'
}

# Files to strictly ignore (exact matches)
EXCLUDED_FILES = {
    'package-lock.json', 'yarn.lock', 'composer.lock', 
    'bundler.py', OUTPUT_FILE, '.DS_Store'
}

def is_text_file(filepath):
    """Simple check to avoid reading binary files by accident."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            f.read(1024)
        return True
    except (UnicodeDecodeError, IOError):
        return False

def bundle_code():
    print(f"🚀 Starting bundle process in: {os.path.abspath(PROJECT_ROOT)}")
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
        # Write a header for the AI
        outfile.write(f"# CODEBASE BUNDLE\n")
        outfile.write(f"# Generated for AI Context\n")
        outfile.write(f"# ==========================================\n\n")

        file_count = 0
        
        for root, dirs, files in os.walk(PROJECT_ROOT):
            # 1. Modify dirs in-place to skip excluded folders so os.walk doesn't enter them
            dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
            
            for file in files:
                if file in EXCLUDED_FILES:
                    continue
                
                _, ext = os.path.splitext(file)
                
                # Check extension matches our whitelist
                if ext in INCLUDED_EXTENSIONS:
                    filepath = os.path.join(root, file)
                    
                    # Optional: Skip binary files just in case
                    if not is_text_file(filepath):
                        continue

                    # create a relative path for cleaner reading
                    rel_path = os.path.relpath(filepath, PROJECT_ROOT)
                    
                    try:
                        with open(filepath, 'r', encoding='utf-8') as infile:
                            content = infile.read()
                            
                            # --- THE FORMATTING MAGIC ---
                            # This format helps me distinguish files easily
                            outfile.write(f"--- START OF FILE: {rel_path} ---\n")
                            outfile.write(content)
                            outfile.write(f"\n--- END OF FILE: {rel_path} ---\n\n")
                            
                            file_count += 1
                            print(f"  [+] Added: {rel_path}")
                            
                    except Exception as e:
                        print(f"  [!] Error reading {rel_path}: {e}")

    print(f"\n✅ Bundling complete!")
    print(f"📄 Output saved to: {os.path.abspath(OUTPUT_FILE)}")
    print(f"📊 Total files included: {file_count}")

if __name__ == "__main__":
    bundle_code()