local MODREV, SPECREV = 'scm', '-1'

rockspec_format = "3.0"
package = 'magenta.nvim'
version = MODREV .. SPECREV

description = {
    summary = 'A Neovim plugin for magenta',
    detailed = [[
        A Neovim plugin that provides magenta functionality.
        Features include a sidebar and more.
    ]],
    homepage = 'https://github.com/denislantsman/magenta.nvim',
    license = 'MIT',
}

dependencies = {
    'lua >= 5.1',
    'nui.nvim',
}

source = {
    url = 'git://github.com/denislantsman/magenta.nvim',
}

build = {
    type = 'builtin',
    copy_directories = {
        'plugin',
        'doc',
    },
}

test = {
    type = "busted",
}
