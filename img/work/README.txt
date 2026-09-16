Real portfolio images live here.

Open the served page, turn on the editor (the EDIT corner, or edit() in
the F12 console), and add photos where they go:

  a carousel (a home page project, or its deep dive): press (+) on it,
    or drop photos onto it
  a gallery section: press + Photo in its band, press Choose a photo on
    the empty tile a new section shows, or drop photos onto it

The Add a photo box takes JPG, PNG, WebP and GIF files from anywhere on
your machine, several at once, and Save to repo writes three files for
each one into this folder, beside the page that shows it:

  <name>-<hash>_sd.webp          a small copy, 480px on its long edge
  <name>-<hash>.jpg              the copy the page shows, 1920px
  <name>-<hash>_original.<ext>   the file as it came, less its location,
                                 camera and date data unless you keep them

<hash> is six characters from the file's bytes. The same file added twice
gets the same name, and another file with the same name gets another hash,
so a save never overwrites a photo a page shows. Then commit and push.

A GIF is taken too. Its two copies are stills of its first frame, and its
original keeps every frame. Each photo's row in the editor has a Display
Maximum UHD switch, which makes the page show the original in place of
the 1920px copy; a GIF has it on, so the GIF moves.

An original over 100 MB is still saved, and the editor says so: GitHub
refuses a file that size in a push, so that one file goes up by hand.

On each Save to repo, a file here that no page names any more is moved
into deletethese/ at the root of the repo, if its name has the shape
above. That folder is in .gitignore: the commit shows the file deleted,
and you empty the folder when you are sure. A file named any other way is
never moved.

