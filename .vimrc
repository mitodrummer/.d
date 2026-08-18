" .vimrc — Minimal webapp dev environment
" Plugin-free. Vim 9+ huge. Uses rg + fd + pnpm.
" Usage: `vim -u .vimrc` inside the project, or symlink to ~/.vimrc.

set nocompatible
filetype plugin indent on
syntax enable

" ── Sensible defaults ────────────────────────────────────────────────
set encoding=utf-8
set hidden
set number
set cursorline
set signcolumn=yes
set scrolloff=5 sidescrolloff=8
set splitbelow splitright
set mouse=a
set ttimeoutlen=10
set updatetime=300
set shortmess+=c
set backspace=indent,eol,start
set nowrap
set colorcolumn=100
set termguicolors
set background=dark
silent! colorscheme habamax

" ── Search ───────────────────────────────────────────────────────────
set ignorecase smartcase
set incsearch hlsearch
nnoremap <silent> <Esc> :nohlsearch<CR>

" ── Indentation (project: 2-space, no tabs, LF) ──────────────────────
set expandtab
set shiftwidth=2 softtabstop=2 tabstop=2
set smartindent autoindent
set fileformat=unix

" ── Undo / swap / backup ─────────────────────────────────────────────
" $HOME may be read-only (sandbox); fall back to /tmp and skip backups.
set nobackup nowritebackup
let s:vimdir = filewritable(expand('~')) == 2 ? expand('~/.vim') : '/tmp/.vim-' . $USER
set undofile
let &undodir = s:vimdir . '/undo//'
let &directory = s:vimdir . '/swap//'
silent! call mkdir(s:vimdir . '/undo', 'p')
silent! call mkdir(s:vimdir . '/swap', 'p')

" ── Clipboard ────────────────────────────────────────────────────────
if has('clipboard_working')
  set clipboard=unnamedplus
endi

" ── Wildmenu / file completion ───────────────────────────────────────
set path+=**
set wildmenu
set wildoptions=pum,fuzzy
set wildmode=longest:full,full
set wildignore+=*/node_modules/*,*/dist/*,*/.astro/*,*/.git/*
set wildignore+=*/.cache/*,*/coverage/*,*/playwright-report/*,*/test-results/*
set wildignore+=*.log,*.lock

" ── Leader ───────────────────────────────────────────────────────────
let mapleader = " "

" ── Ctrl-P: live fuzzy file open (fzf + fd) ──────────────────────────
" Requires fzf + fd on PATH (fzf ships with the dev loadout's packages; fd and
" rg come from the project's own session packages).
" Opens an interactive fzf in a bottom split; results filter as you type.
function! s:FzfRun(source_cmd, sink) abort
  let l:tmp = tempname()
  let l:orig_win = win_getid()
  let l:orig_buf = bufnr('%')
  let l:shell_cmd = a:source_cmd . ' | fzf --height=100% --reverse --border '
        \ . '--prompt="> " > ' . shellescape(l:tmp)
  botright 15split
  call term_start(['sh', '-c', l:shell_cmd], {
        \ 'curwin': 1,
        \ 'term_finish': 'close',
        \ 'exit_cb': function('s:FzfDone', [l:tmp, a:sink, l:orig_win, l:orig_buf]),
        \ })
  startinsert
endfunction

function! s:FzfDone(tmp, sink, orig_win, orig_buf, job, status) abort
  if filereadable(a:tmp)
    let l:lines = readfile(a:tmp)
    call delete(a:tmp)
    if !empty(l:lines) && !empty(l:lines[0])
      call win_gotoid(a:orig_win)
      call call(a:sink, [l:lines[0]])
      " Wipe the original buffer if it was an empty no-name scratch
      if bufexists(a:orig_buf) && a:orig_buf != bufnr('%')
            \ && empty(bufname(a:orig_buf))
            \ && !getbufvar(a:orig_buf, '&modified')
            \ && getbufvar(a:orig_buf, '&buftype') ==# ''
        execute 'bwipeout ' . a:orig_buf
      endif
    endif
  endif
endfunction

function! s:OpenFile(line) abort
  execute 'edit ' . fnameescape(a:line)
endfunction

function! s:OpenGrepHit(line) abort
  " rg --vimgrep format: path:line:col:text
  let l:parts = matchlist(a:line, '^\([^:]*\):\(\d\+\):\(\d\+\):')
  if empty(l:parts) | return | endif
  execute 'edit +' . l:parts[2] . ' ' . fnameescape(l:parts[1])
  execute 'normal! ' . l:parts[3] . '|'
endfunction

function! s:OpenBuffer(line) abort
  let l:bufnr = matchstr(a:line, '^\s*\zs\d\+')
  if !empty(l:bufnr) | execute 'buffer ' . l:bufnr | endif
endfunction

command! Files call <SID>FzfRun(
      \ 'fd --type f --hidden --exclude .git --exclude node_modules '
      \ . '--exclude dist --exclude .astro',
      \ function('<SID>OpenFile'))

command! -nargs=? RgFzf call <SID>FzfRun(
      \ 'rg --vimgrep --smart-case --hidden --glob=!.git '
      \ . shellescape(empty(<q-args>) ? '' : <q-args>),
      \ function('<SID>OpenGrepHit'))

" The buffer list has to be captured from THIS Vim: a `vim -e -c "ls"`
" subprocess lists its own (empty) buffers, so the old shell pipeline handed
" fzf nothing and `:Buffers` could never open anything. Dump `:ls` to a
" tempfile — Vim wipes its temp dir on exit — and let fzf read that.
function! s:BuffersFzf() abort
  let l:list = tempname()
  call writefile(split(execute('ls'), "\n"), l:list)
  call s:FzfRun('cat ' . shellescape(l:list), function('<SID>OpenBuffer'))
endfunction

command! Buffers call <SID>BuffersFzf()

nnoremap <C-p> :Files<CR>
nnoremap <leader>p :Files<CR>
nnoremap <C-b> :Buffers<CR>
nnoremap <leader>f :RgFzf<Space>

" ── Ripgrep integration ──────────────────────────────────────────────
if executable('rg')
  set grepprg=rg\ --vimgrep\ --smart-case\ --hidden\ --glob=!.git
  set grepformat=%f:%l:%c:%m
endif
command! -nargs=+ -complete=file Rg silent grep! <args> | copen | redraw!
nnoremap <leader>/ :Rg<Space>
nnoremap <leader>* :Rg <C-r><C-w><CR>

" ── Quickfix navigation ──────────────────────────────────────────────
nnoremap ]q :cnext<CR>
nnoremap [q :cprev<CR>
nnoremap <leader>q :cclose<CR>

" ── Project tooling (pnpm) ───────────────────────────────────────────
command! Lint    cexpr system('pnpm run lint 2>&1')     | copen
command! LintFix cexpr system('pnpm run lint:fix 2>&1') | copen
command! Check   cexpr system('pnpm run check 2>&1')    | copen
command! Test    cexpr system('pnpm run test 2>&1')     | copen
command! Build   cexpr system('pnpm run build 2>&1')    | copen
command! DbCheck cexpr system('pnpm run db:check 2>&1') | copen

nnoremap <leader>l :Lint<CR>
nnoremap <leader>L :LintFix<CR>
nnoremap <leader>c :Check<CR>
nnoremap <leader>t :Test<CR>

" Cmd+S save — Ghostty sends \x13 (Ctrl+S) on cmd+s; flow control disabled in shell rc.
nnoremap <C-s> :w<CR>
inoremap <C-s> <Esc>:w<CR>gi
vnoremap <C-s> <Esc>:w<CR>gv

" Format current buffer through Biome (respects project config)
command! Format execute '%!pnpm exec biome format --stdin-file-path='
      \ . shellescape(expand('%'))
nnoremap <leader>= :Format<CR>

" Format-on-save via Biome — only when project has biome.json upward of cwd.
" Uses `biome check --write` so formatter + safe lint fixes (incl. sorted
" Tailwind classes) both run. Replaces buffer only if biome exits 0 and
" output differs.
function! s:BiomeFormatOnSave() abort
  if empty(findfile('biome.json', '.;')) | return | endif
  if !executable('pnpm') | return | endif
  let l:view = winsaveview()
  let l:lines = getline(1, '$')
  let l:input = join(l:lines, "\n")
  let l:cmd = 'pnpm exec biome check --write --stdin-file-path=' . shellescape(expand('%'))
  let l:output = systemlist(l:cmd, l:input)
  if v:shell_error == 0 && !empty(l:output) && l:output !=# l:lines
    silent! keepjumps call setline(1, l:output)
    if line('$') > len(l:output)
      silent! execute (len(l:output) + 1) . ',$delete _'
    endif
  endif
  call winrestview(l:view)
endfunction

augroup BiomeFormatOnSave
  autocmd!
  autocmd BufWritePre *.astro,*.ts,*.tsx,*.mts,*.cts,*.js,*.jsx,*.mjs,*.cjs,*.json,*.jsonc,*.css
        \ call s:BiomeFormatOnSave()
augroup END

" Sort Tailwind classes in saved .astro files. CI does not run this — biome's
" useSortedClasses rule does not yet autofix HTML class="..." attributes — so
" we route the saved file through scripts/sort-classes.ts and let `autoread`
" pull the rewritten content back into the buffer.
function! s:SortClassesOnSave() abort
  let l:script = findfile('scripts/sort-classes.ts', '.;')
  if empty(l:script) | return | endif
  call system('node ' . shellescape(l:script) . ' ' . shellescape(expand('%:p')))
  silent! checktime
endfunction

augroup SortClassesOnSave
  autocmd!
  autocmd BufWritePost *.astro call s:SortClassesOnSave()
augroup END

" Auto-reload buffers when files change on disk (covers external formatters,
" git operations, etc.). `:checktime` on focus/cursor-hold triggers the read.
set autoread
augroup AutoReload
  autocmd!
  autocmd FocusGained,BufEnter,CursorHold,CursorHoldI * silent! checktime
augroup END

" Dev server helpers — scripts/dev.sh is the project's background runner
command! DevStart  !scripts/dev.sh start
command! DevStop   !scripts/dev.sh stop
command! DevLogs   !scripts/dev.sh logs
command! DevStatus !scripts/dev.sh status

" ── Astro / TS filetypes ─────────────────────────────────────────────
augroup FiletypeTweaks
  autocmd!
  autocmd BufNewFile,BufRead *.astro setfiletype astro
  autocmd BufRead,BufNewFile *.astro setlocal syntax=html
  autocmd FileType astro setlocal commentstring=<!--\ %s\ -->
  autocmd FileType typescript,typescriptreact,javascript,json,astro,html,css,yaml
        \ setlocal shiftwidth=2 softtabstop=2 expandtab
  " `gf` on import paths: resolve @/ → src/ and try these extensions.
  autocmd FileType astro,typescript,typescriptreact,javascript
        \ setlocal suffixesadd=.astro,.ts,.tsx,.js,.jsx,.mjs,.svg,.css
        \ | setlocal includeexpr=substitute(v:fname,'^@/','src/','')
        \ | setlocal path+=src,src/components,src/lib,src/pages
augroup END

" ── Netrw (built-in explorer) ────────────────────────────────────────
let g:netrw_banner = 0
let g:netrw_liststyle = 3
let g:netrw_winsize = 25
nnoremap <leader>e :Lexplore<CR>

" ── Quality-of-life mappings ─────────────────────────────────────────
nnoremap <leader>w :w<CR>
nnoremap <leader>Q :qa<CR>
vnoremap p "_dP
vnoremap < <gv
vnoremap > >gv
nnoremap <A-j> :m .+1<CR>==
nnoremap <A-k> :m .-2<CR>==
vnoremap <A-j> :m '>+1<CR>gv=gv
vnoremap <A-k> :m '<-2<CR>gv=gv
nnoremap <C-h> <C-w>h
nnoremap <C-j> <C-w>j
nnoremap <C-k> <C-w>k
nnoremap <C-l> <C-w>l

" `gb` pops the jumplist (mirrors `gf` going forward into a file). gB
" pushes back forward through the jumplist for symmetry with `Ctrl-I`.
nnoremap gb <C-o>
nnoremap gB <C-i>

" ── Trailing whitespace ──────────────────────────────────────────────
highlight TrailingWS ctermbg=red guibg=#ff5555
match TrailingWS /\s\+$/
command! StripWS %s/\s\+$//e | nohlsearch

" ── Status line ──────────────────────────────────────────────────────
set laststatus=2
set statusline=%f\ %m%r%h%w\ %=\ %y\ [%{&ff}]\ %l:%c\ %p%%
